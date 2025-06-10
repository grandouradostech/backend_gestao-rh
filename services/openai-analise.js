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

function extrairRequisitosCriticos(requisitos) {
  const palavrasChaveCriticas = [
    'cnh', 'transporte de cargas', 'ear', 'experiência na função', 'experiência mínima',
    'disponibilidade', 'ensino fundamental', 'ensino médio', 'ensino superior',
    'aptidão física', 'dirigir em rodovias', 'carro próprio', 'idade'
  ];

  return requisitos.filter(req =>
    palavrasChaveCriticas.some(palavra =>
      req.toLowerCase().includes(palavra)
    )
  );
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

async function analisarCandidatura(response, caminhoCurriculo, requisitosVaga = null) {
  let rawAnalysis;
  try {
    const textoCurriculo = caminhoCurriculo 
      ? await processarCurriculo(response.response_id)
      : 'Nenhum currículo enviado';

    const dadosSanitized = sanitizarTexto(JSON.stringify({
      formulario: response.answers,
      curriculo: textoCurriculo
    }));

    let requisitosArr = [];
    let diferenciaisArr = [];
    let descricaoVaga = '';
    let tituloVaga = '';
    let cidadesArr = [];
    if (requisitosVaga) {
      if (typeof requisitosVaga.requisito === 'string') {
        requisitosArr = requisitosVaga.requisito.split(',').map(r => r.trim()).filter(Boolean);
      } else if (Array.isArray(requisitosVaga.requisito)) {
        requisitosArr = requisitosVaga.requisito;
      }
      if (typeof requisitosVaga.diferencial === 'string') {
        diferenciaisArr = requisitosVaga.diferencial.split(',').map(d => d.trim()).filter(Boolean);
      } else if (Array.isArray(requisitosVaga.diferencial)) {
        diferenciaisArr = requisitosVaga.diferencial;
      }
      if (typeof requisitosVaga.cidades === 'string') {
        cidadesArr = requisitosVaga.cidades.split(',').map(c => c.trim()).filter(Boolean);
      } else if (Array.isArray(requisitosVaga.cidades)) {
        cidadesArr = requisitosVaga.cidades;
      }
      descricaoVaga = requisitosVaga.descricao || '';
      tituloVaga = requisitosVaga.vaga_nome || requisitosVaga.titulo || '';
    }

    const requisitosObrigatorios = extrairRequisitosCriticos(requisitosArr);

    let prompt = '';
    if (requisitosArr.length > 0) {
      prompt = `Você é um especialista em recrutamento e seleção. Avalie o candidato abaixo com base nas informações fornecidas e nos requisitos da vaga, seguindo estas regras:

1. Requisitos marcados como obrigatórios são ESSENCIAIS. Se o candidato não atender a qualquer um deles e não houver justificativa plausível, a pontuação deve ser baixa (abaixo de 60) e "recomendado" deve ser false.
2. Níveis mais altos de escolaridade atendem automaticamente aos níveis mais baixos.
3. Considere experiências similares, mesmo que não sejam exatamente na função. Atividades informais ou voluntárias relacionadas contam parcialmente.
4. Caso o currículo esteja ausente, baseie-se apenas nas respostas do formulário.
5. Falta de informação (como CNH, rotas locais, disponibilidade) deve ser citada como ponto fraco se for relevante.

Responda estritamente em formato JSON com o seguinte esquema:
{
  "pontuacao_final": número de 0 a 100 (obrigatório, nunca omita),
  "compatibilidade": "baixa" | "média" | "alta",
  "justificativa": "Texto explicando a análise (em linguagem objetiva e clara)",
  "recomendado": true | false,
  "pontos_fortes": [lista de pontos fortes],
  "pontos_fracos": [lista de pontos fracos ou ausências de informação]
}

--- DADOS_DO_CANDIDATO:
${dadosSanitized}

--- REQUISITOS_DA_VAGA:
${JSON.stringify({
  titulo: tituloVaga,
  descricao: descricaoVaga,
  requisitos: requisitosArr,
  diferenciais: diferenciaisArr,
  cidades: cidadesArr
})}

--- REQUISITOS_OBRIGATORIOS:
${JSON.stringify(requisitosObrigatorios)}
`;
    } else {
      prompt = `Você é um especialista em recrutamento e seleção. Com base apenas nos dados fornecidos do candidato abaixo, avalie se ele parece adequado para uma vaga em geral. Use bom senso e responda estritamente no seguinte formato JSON:

{
  "pontuacao_final": número de 0 a 100 (obrigatório, nunca omita),
  "compatibilidade": "baixa" | "média" | "alta",
  "justificativa": "Texto explicando a análise (em linguagem objetiva e clara)",
  "recomendado": true | false,
  "pontos_fortes": [lista de pontos fortes],
  "pontos_fracos": [lista de pontos fracos ou ausências de informação]
}

--- DADOS_DO_CANDIDATO:
${dadosSanitized}
`;
    }

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
        return {
          error: "Erro na análise",
          details: error.message,
          raw: rawAnalysis
        };
      }
    }
  } catch (error) {
    console.error('🔍 Erro na análise da candidatura:', error.message);
    return { error: "Erro na análise", details: error.message };
  }
}

module.exports = {
  analisarCandidatura,
  estruturarDados
};
