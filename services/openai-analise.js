const { OpenAI } = require('openai');
const Tesseract = require('tesseract.js');
const pdf = require('pdf-parse');
const { createClient } = require('@supabase/supabase-js');
const { jsonrepair } = require('jsonrepair');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_KEY
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function sanitizarTexto(texto) {
  return texto
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
    .replace(/\r/g, '\\r');
}

async function processarCurriculo(responseId) {
  try {
    const { data: arquivos, error } = await supabase.storage
      .from('curriculo')
      .list(responseId, { limit: 1 });

    if (error || !arquivos?.length) return null;

    const arquivo = arquivos[0];
    const caminho = `${responseId}/${arquivo.name}`;
    
    const { data: fileData, error: downloadError } = await supabase.storage
      .from('curriculo')
      .download(caminho);

    if (downloadError) throw downloadError;

    const arrayBuffer = await fileData.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    if (['jpg', 'jpeg', 'png'].includes(arquivo.name.split('.').pop().toLowerCase())) {
      const { data: { text } } = await Tesseract.recognize(buffer, 'por');
      return sanitizarTexto(text.substring(0, 2000));
    }
    
    if (arquivo.name.endsWith('.pdf')) {
      const data = await pdf(buffer);
      return sanitizarTexto(data.text.substring(0, 2000));
    }

    return null;
  } catch (error) {
    console.error('🔧 Erro no processamento do currículo:', error.message);
    return null;
  }
}

async function estruturarDados(response) {
  try {
    const answersSanitized = sanitizarTexto(JSON.stringify(response.answers));
    
    const prompt = `Estruture estes dados de formulário em JSON válido:
    {
      "pessoal": {
        "nome": "Texto",
        "email": "Texto",
        "telefone": "Texto",
        "cpf": "Texto",
        "cidade": "Texto"
      },
      "profissional": {
        "vaga": "Texto",
        "experiencia": "Texto",
        "escolaridade": "Texto"
      }
    }
    
    Dados brutos: ${answersSanitized}`;

    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo-0125",
      messages: [{ role: "system", content: prompt }],
      temperature: 0.1,
      max_tokens: 500,
      response_format: { type: "json_object" }
    });

    const rawJSON = completion.choices[0].message.content;
    const validJSON = rawJSON
      .replace(/\\\"/g, '"')
      .replace(/'/g, '"')
      .replace(/}\s*{/g, '},{')
      .replace(/,\s*}/g, '}');

    return JSON.parse(validJSON);
  } catch (error) {
    console.error('📄 Erro na estruturação dos dados:', error.message);
    return null;
  }
}

async function analisarCandidatura(response, caminhoCurriculo) {
  let rawAnalysis;
  try {
    const textoCurriculo = caminhoCurriculo 
      ? await processarCurriculo(response.response_id)
      : 'Nenhum currículo enviado';

    const dadosSanitized = sanitizarTexto(JSON.stringify({
      formulario: response.answers,
      curriculo: textoCurriculo
    }));

    const prompt = `Você é um especialista em recrutamento e seleção, extremamente criterioso e analítico.

Sua tarefa é analisar um candidato com base nas seguintes informações, fornecendo sua análise exclusivamente no formato JSON.

---
REGRAS E LÓGICA DA ANÁLISE:

1.  Seja Criterioso: A pontuação deve ser rigorosa. Pré-requisitos não atendidos devem impactar a nota severamente.
2.  Baseie-se em Evidências: Não presuma ou invente informações. Todas as análises devem ser baseadas nos dados fornecidos.
3.  Pontuação Objetiva: Para o campo "pontuacao_final", gere um número isolado de 0 a 100, considerando a aderência do candidato aos pré-requisitos, diferenciais e atividades da vaga.
4.  Lógica da Recomendação: Para o campo "recomendacao", use a pontuação final como base:
    - De 0 a 40: "Não Recomendado"
    - De 41 a 70: "Recomendado"
    - De 71 a 100: "Altamente Recomendado"
5.  Formato JSON Exclusivo: Sua resposta final deve ser APENAS o código JSON, sem nenhum texto introdutório ou final.

ANÁLISE ESPERADA (SAÍDA EM FORMATO JSON):
{
  "resumo_profissional": "Um resumo conciso do perfil do candidato e sua adequação à vaga.",
  "pontos_fortes": [
    {
      "ponto": "Exemplo: Formação acadêmica relevante.",
      "evidencia": "Exemplo: Currículo menciona sua graduação em Engenharia."
    }
  ],
  "pontos_fracos": [
    {
      "ponto": "Exemplo: Falta de experiência direta.",
      "evidencia": "Exemplo: Questionário indica que nunca trabalhou com entregas."
    }
  ],
  "pontuacao_final": 0,
  "justificativa_pontuacao": "A pontuação foi definida com base na falta do pré-requisito X, mas considerando a boa aderência ao diferencial Y.",
  "recomendacao": "Não Recomendado",
  "perguntas_entrevista": [
    "Primeira pergunta baseada nos pontos fracos ou red flags...",
    "Segunda pergunta para explorar uma possível inconsistência..."
  ]
}

DADOS DO CANDIDATO:
${dadosSanitized}`;

    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo-0125",
      messages: [{ role: "system", content: prompt }],
      temperature: 0.1,
      max_tokens: 500,
      response_format: { type: "json_object" }
    });

    rawAnalysis = completion.choices[0].message.content;
    const validAnalysis = rawAnalysis
      .replace(/'/g, '"')
      .replace(/\"/g, '"')
      .replace(/},\s*}/g, '}}');

    try {
      return JSON.parse(validAnalysis);
    } catch (error) {
      try {
        const repaired = jsonrepair(validAnalysis);
        return JSON.parse(repaired);
      } catch (err2) {
        console.error('Erro ao reparar/parsear JSON da IA:', error.message, '\nResposta crua:', rawAnalysis);
        return {
          error: "Erro na análise",
          details: error.message,
          raw: rawAnalysis
        };
      }
    }
  } catch (error) {
    console.error('🔍 Erro na análise da candidatura:', error.message);
    if (typeof rawAnalysis !== 'undefined') {
    }
    return { 
      error: "Erro na análise",
      details: error.message 
    };
  }
}

module.exports = {
  analisarCandidatura,
  estruturarDados
};