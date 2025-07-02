const { OpenAI } = require('openai');
const Tesseract = require('tesseract.js');
const pdf = require('pdf-parse');
const { createClient } = require('@supabase/supabase-js');
const { jsonrepair } = require('jsonrepair');
const sharp = require('sharp');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_KEY
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const FORMULARIO_CAMPO_NOME = {
  'ynFUyrAc': '6VkDMDJph5Jc',
  'i6GB06nW': 'c0SRbHskERPD',
  'OejwZ32V': 'w0kqjkpQ8Oav',
};

function sanitizarTexto(texto) {
  return texto.replace(/\\/g, '\\\\')
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
      try {
        // Tenta otimizar a imagem antes do OCR
        const optimizedBuffer = await sharp(buffer)
          .resize(2000, 2000, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 90 })
          .toBuffer();

        const { data: { text } } = await Tesseract.recognize(optimizedBuffer, 'por', {
          logger: m => {
            if (m.status === 'recognizing text') {
              console.log(`[OCR] Progresso: ${Math.round(m.progress * 100)}%`);
            }
          }
        });
        return sanitizarTexto(text.substring(0, 2000));
      } catch (ocrError) {
        console.error('🔧 Erro no OCR:', ocrError.message);
        // Se falhar no OCR, tenta ler como PDF
        try {
          const data = await pdf(buffer);
          return sanitizarTexto(data.text.substring(0, 2000));
        } catch (pdfError) {
          console.error('🔧 Erro ao ler como PDF:', pdfError.message);
          return null;
        }
      }
    }

    if (arquivo.name.endsWith('.pdf')) {
      try {
        const data = await pdf(buffer);
        return sanitizarTexto(data.text.substring(0, 2000));
      } catch (pdfError) {
        console.error('🔧 Erro ao ler PDF:', pdfError.message);
        return null;
      }
    }

    return null;
  } catch (error) {
    console.error('🔧 Erro no processamento do currículo:', error.message);
    return null;
  }
}


async function estruturarDados(response, formId) {
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
      model: "gpt-3.5-turbo",
      messages: [{ role: "system", content: prompt }],
      temperature: 0.1,
      max_tokens: 500,
      response_format: { type: "json_object" }
    });

    const rawJSON = completion.choices[0].message.content;
    const validJSON = rawJSON.replace(/\\\"/g, '"').replace(/'/g, '"').replace(/},\s*}/g, '}}');

    return JSON.parse(validJSON);
  } catch (error) {
    console.error('📄 Erro na estruturação dos dados:', error.message);
    return null;
  }
}

async function obterNome(response, formId, dadosEstruturados) {
  const idCampoNome = FORMULARIO_CAMPO_NOME[formId];

  const campoNome = response.answers?.find(a => a.field?.id === idCampoNome) || null;
  if (campoNome?.text) return campoNome.text;

  const nomeEstruturado = dadosEstruturados?.pessoal?.nome;
  if (nomeEstruturado && nomeEstruturado.toLowerCase() !== 'texto' && nomeEstruturado.length > 1)
    return nomeEstruturado;

  return 'Não identificado';
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
      requisitosArr = Array.isArray(requisitosVaga.requisito)
        ? requisitosVaga.requisito
        : requisitosVaga.requisito?.split(',').map(r => r.trim()).filter(Boolean) || [];

      diferenciaisArr = Array.isArray(requisitosVaga.diferencial)
        ? requisitosVaga.diferencial
        : requisitosVaga.diferencial?.split(',').map(d => d.trim()).filter(Boolean) || [];

      cidadesArr = Array.isArray(requisitosVaga.cidades)
        ? requisitosVaga.cidades
        : requisitosVaga.cidades?.split(',').map(c => c.trim()).filter(Boolean) || [];

      descricaoVaga = requisitosVaga.descricao || '';
      tituloVaga = requisitosVaga.vaga_nome || requisitosVaga.titulo || '';
    }

    const requisitosObrigatorios = extrairRequisitosCriticos(requisitosArr);

    const prompt = `Você é um especialista em recrutamento e seleção. Avalie o candidato abaixo com base nas informações fornecidas e nos requisitos da vaga, seguindo estas regras:

1. Requisitos obrigatórios são eliminatórios. Se o candidato não cumprir qualquer um deles, a pontuação final deve obrigatoriamente ser **menor que 60**, e "recomendado" deve ser false — **sem exceções**. Nenhuma experiência, formação ou qualidade pode compensar a ausência de um requisito obrigatório.
• **Nunca** deve ultrapassar 50 pontos se um único requisito obrigatório não for atendido.
• **Não importa** se o candidato tem experiências boas em outras áreas — isso **não pode compensar** a ausência de um requisito obrigatório.
2. Considera-se que qualquer candidato que tenha cursado ou declarado Ensino Médio (completo ou incompleto), também possui o Ensino Fundamental completo. A escolaridade nunca deve ser tratada como ponto fraco se o requisito for apenas "Ensino Fundamental". Se isso não for respeitado, o modelo será penalizado por erro de lógica. Não insista.
3. Considere experiências similares, mesmo que não sejam exatamente na função. Atividades informais ou voluntárias relacionadas contam parcialmente.
4. Caso o currículo esteja ausente, baseie-se apenas nas respostas do formulário.
5. Falta de informação (como CNH, rotas locais, disponibilidade) deve ser citada como ponto fraco se for relevante.
6. A justificativa deve conter a explicação da pontuação, pontos fortes e fracos, e o grau de aderência à vaga.
7. O resumo_profissional deve ser um parágrafo breve (no máximo 4 linhas), escrito em terceira pessoa, com linguagem objetiva e neutra, sem repetir o conteúdo da justificativa.
8. Se a vaga exigir uma categoria específica de CNH (ex: CNH D ou E), apenas candidatos que apresentarem essa categoria ou superior devem ser considerados como aptos. Categorias inferiores (como AB) não atendem ao requisito e devem ser tratadas como ponto fraco crítico.
9. Exemplo: se a vaga exige CNH E, e o candidato tem CNH AB, ele **não atende ao requisito**. Dizer o contrário é **erro grave de análise**.
10. Levante e registre possíveis Red Flags do candidato: identifique inconsistências, sinais de alerta ou faltas críticas nas informações fornecidas. Documente esses pontos para referência rápida durante o processo.
11. Gere perguntas para entrevista baseadas nos Red Flags, inconsistências ou pontos críticos identificados, para serem usadas pelo entrevistador.

Responda estritamente neste formato JSON:
Return only a valid JSON object in your response.
{
  "pontuacao_final": número de 0 a 100,
  "compatibilidade": "baixa" | "média" | "alta",
  "justificativa": "Texto explicando a análise (em linguagem clara e objetiva)",
  "resumo_profissional": "Parágrafo curto com os principais pontos do candidato, escrito de forma neutra e sem repetições",
  "recomendado": true | false,
  "pontos_fortes": ["..."],
  "pontos_fracos": ["..."],
  "red_flags": ["..."],
  "perguntas_entrevista": ["..."]
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
${JSON.stringify(requisitosObrigatorios)}`;

    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        { role: "system", content: "Você é um especialista em triagem de currículos para processos seletivos. Siga as instruções do prompt rigorosamente." },
        { role: "user", content: prompt }
      ],
      temperature: 0.1,
      max_tokens: 1000,
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
  sanitizarTexto,
  extrairRequisitosCriticos,
  processarCurriculo,
  estruturarDados,
  obterNome,
  analisarCandidatura
};
