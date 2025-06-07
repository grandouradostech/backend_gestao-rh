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

    // Novo prompt super robusto
    let prompt = '';
    // Estruturar requisitos e diferenciais como arrays
    let requisitosArr = [];
    let diferenciaisArr = [];
    let descricaoVaga = '';
    let tituloVaga = '';
    let cidadesArr = [];
    if (requisitosVaga) {
      // Tenta converter requisitos e diferenciais em arrays
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
    prompt = `Você é um especialista em recrutamento e seleção.\nSua tarefa é analisar um candidato para uma vaga, com base nas informações abaixo, e fornecer sua análise exclusivamente no formato JSON.\n\n---\nREGRAS E LÓGICA DA ANÁLISE\n\n1. Considere apenas os requisitos e diferenciais explicitamente listados na vaga (veja o campo requisitos_da_vaga abaixo).\n   - Não penalize o candidato por informações pessoais (como estado civil, filhos, etc.) a menos que estejam nos requisitos.\n   - Ignore informações que não estejam relacionadas aos requisitos ou diferenciais da vaga.\n2. Requisitos obrigatórios devem ter peso maior na pontuação.\n   - Se o candidato não atender a um requisito obrigatório, isso deve impactar fortemente a nota.\n   - Diferenciais servem apenas para agregar pontos, nunca para descontar.\n3. Se faltar informação para algum requisito obrigatório, mencione isso na análise e desconte pontos apenas se a ausência impedir a avaliação do requisito.\n4. Baseie-se apenas em evidências: não presuma ou invente informações. Todas as análises devem ser baseadas nos dados fornecidos.\n5. Pontuação:\n   - Para o campo \"pontuacao_final\", gere um número de 0 a 100, considerando a aderência do candidato aos requisitos obrigatórios e diferenciais.\n   - Explique claramente como chegou a essa nota.\n6. Justificativa estruturada:\n   - Liste em um array os motivos de desconto de pontos (por requisito não atendido ou informação ausente).\n   - Liste em outro array os motivos de bônus (por diferenciais atendidos).\n   - Além disso, forneça um texto livre resumindo a justificativa.\n7. Recomendação:\n   - Use a pontuação final como base:\n     - De 0 a 40: \"Não Recomendado\"\n     - De 41 a 70: \"Recomendado\"\n     - De 71 a 100: \"Altamente Recomendado\"\n8. Perguntas para entrevista:\n   - Gere perguntas focadas nos pontos fracos, dúvidas ou inconsistências identificadas nas respostas do candidato.\n9. Formato de resposta:\n   - Sua resposta final deve ser APENAS o código JSON, sem nenhum texto introdutório ou final.\n\n---\nDADOS_DO_CANDIDATO:\n${dadosSanitized}\n\nREQUISITOS_DA_VAGA:\n${JSON.stringify({
      titulo: tituloVaga,
      descricao: descricaoVaga,
      requisitos: requisitosArr,
      diferenciais: diferenciaisArr,
      cidades: cidadesArr
    })}`;

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