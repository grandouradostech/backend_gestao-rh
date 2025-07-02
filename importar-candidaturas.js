require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');
const { analisarCandidatura, estruturarDados } = require('./services/openai-analise');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    },
    global: {
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`
      }
    }
  }
);

const FORM_IDS = ['ynFUyrAc', 'i6GB06nW', 'OejwZ32V'];
const IDS_CURRICULO = [
  '3906df64-4b2f-4d6b-9b86-84a48a329ba2',
  'uWyR9IgTXhoc',
  '3fJBj1zWtR34',
  'dmlXVJZuZ7BH',
];

const MAPA_CAMPOS = {
  ynFUyrAc: {
    nome: '6VkDMDJph5Jc',
    cpf: 'kyDMKvIiREJN',
    telefone: 'ryREsjI6ocDM',
    email: '0H5FhjQdZsUU',
    dataNascimento: 'YjlVPbYIjF5L'
  },
  i6GB06nW: {
    nome: 'c0SRbHskERPD',
    cpf: '8vaBwiO7kELZ',
    telefone: 'lXkYZdgtJuCM',
    email: 'DRrZHCUp0EhV',
    dataNascimento: 'ZfxImfwRovM8'
  },
  OejwZ32V: {
    nome: 'w0kqjkpQ8Oav',
    cpf: 'xWO9ZhqjMIsx',
    telefone: 'mraynQBpbAew',
    email: 'djlTJfSHbAA4',
    dataNascimento: 'MZeKTR2jRuVF'
  }
};

function extrairCampoTextoPorId(formId, answers, mapaCampos, nomeCampo) {
  const idsCampo = Array.isArray(mapaCampos[formId]?.[nomeCampo]) 
    ? mapaCampos[formId][nomeCampo] 
    : [mapaCampos[formId]?.[nomeCampo]];

  if (!idsCampo || idsCampo.length === 0) {
    console.warn(`   ⚠️ Campo ${nomeCampo} não mapeado para o formulário ${formId}`);
    return null;
  }

  // Debug para ver todas as respostas disponíveis
  console.log(`   🔍 Procurando campo ${nomeCampo} (IDs: ${idsCampo.join(', ')})`);
  
  // Tenta encontrar por qualquer um dos IDs possíveis
  let resposta = null;
  for (const idCampo of idsCampo) {
    // Primeiro tenta encontrar pelo ID do campo
    resposta = answers.find((a) => a?.field?.id === idCampo);
    
    // Se não encontrar, tenta encontrar pelo ref do campo
    if (!resposta) {
      resposta = answers.find((a) => a?.field?.ref === idCampo);
    }

    if (resposta) break;
  }

  if (!resposta) {
    console.warn(`   ⚠️ Resposta não encontrada para o campo ${nomeCampo} (IDs: ${idsCampo.join(', ')})`);
    console.log('   📝 Respostas disponíveis:', JSON.stringify(answers.map(a => ({
      id: a?.field?.id,
      ref: a?.field?.ref,
      type: a?.type,
      value: a?.text || a?.email || a?.phone_number || a?.number || (a?.choice?.label)
    })), null, 2));
    return null;
  }

  // Verifica todos os tipos possíveis
  const valor = resposta.text || 
                resposta.email || 
                resposta.phone_number || 
                resposta.number ||
                (resposta.choice && resposta.choice.label) ||
                null;

  if (!valor) {
    console.warn(`   ⚠️ Valor não encontrado para o campo ${nomeCampo} (IDs: ${idsCampo.join(', ')})`);
  } else {
    console.log(`   ✅ Valor encontrado para ${nomeCampo}: ${valor}`);
  }

  return valor;
}

function sanitizeFilename(filename) {
  return filename
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]/g, '_');
}

function normalizeText(text) {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u2013\u2014\u2015]/g, '-')
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();
}

// Função para extrair e padronizar data de nascimento
function extrairDataNascimento(texto) {
  if (!texto || typeof texto !== 'string') return null;
  
  // Remove espaços extras e normaliza
  let data = texto.trim().toLowerCase();
  
  // Mapeamento de meses em português
  const meses = {
    'janeiro': '01', 'jan': '01',
    'fevereiro': '02', 'fev': '02',
    'março': '03', 'mar': '03', 'marco': '03',
    'abril': '04', 'abr': '04',
    'maio': '05', 'mai': '05',
    'junho': '06', 'jun': '06',
    'julho': '07', 'jul': '07',
    'agosto': '08', 'ago': '08',
    'setembro': '09', 'set': '09',
    'outubro': '10', 'out': '10',
    'novembro': '11', 'nov': '11',
    'dezembro': '12', 'dez': '12'
  };

  // Padrões de data para extração
  const padroes = [
    // DD/MM/YYYY ou DD-MM-YYYY
    /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/,
    // DD.MM.YYYY
    /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/,
    // DD MM YYYY
    /^(\d{1,2})\s+(\d{1,2})\s+(\d{4})$/,
    // DDMMYYYY (sem separadores)
    /^(\d{2})(\d{2})(\d{4})$/,
    // DD de Mês de YYYY (português, aceita acentos)
    /^(\d{1,2})\s+de\s+([\wçãõáéíóúâêîôûàèìòùäëïöüÇÃÕÁÉÍÓÚÂÊÎÔÛÀÈÌÒÙÄËÏÖÜ]+)\s+de\s+(\d{4})$/,
    // DD Mês YYYY (português, aceita acentos)
    /^(\d{1,2})\s+([\wçãõáéíóúâêîôûàèìòùäëïöüÇÃÕÁÉÍÓÚÂÊÎÔÛÀÈÌÒÙÄËÏÖÜ]+)\s+(\d{4})$/,
    // YYYY-MM-DD (formato ISO)
    /^(\d{4})-(\d{1,2})-(\d{1,2})$/
  ];

  // Tenta cada padrão
  for (let i = 0; i < padroes.length; i++) {
    const match = data.match(padroes[i]);
    if (match) {
      let dia, mes, ano;
      
      if (i === 4 || i === 5) {
        // Padrões com meses em português
        dia = match[1].padStart(2, '0');
        const mesNome = match[2];
        // Normaliza o nome do mês para tratar caracteres especiais
        const mesNormalizado = mesNome.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        mes = meses[mesNome] || meses[mesNormalizado];
        ano = match[3];
      } else if (i === 6) {
        // Formato ISO (YYYY-MM-DD)
        ano = match[1];
        mes = match[2].padStart(2, '0');
        dia = match[3].padStart(2, '0');
      } else {
        // Outros formatos
        dia = match[1].padStart(2, '0');
        mes = match[2].padStart(2, '0');
        ano = match[3];
      }

      // Validações básicas
      if (!mes || !meses[mes.toLowerCase()]) {
        // Se não encontrou o mês em português, tenta como número
        if (parseInt(mes) < 1 || parseInt(mes) > 12) continue;
      } else {
        mes = meses[mes.toLowerCase()];
      }

      const diaInt = parseInt(dia);
      const mesInt = parseInt(mes);
      const anoInt = parseInt(ano);

      // Validações de data
      if (diaInt < 1 || diaInt > 31) continue;
      if (mesInt < 1 || mesInt > 12) continue;
      if (anoInt < 1900 || anoInt > new Date().getFullYear()) continue;

      // Validações específicas por mês
      const diasPorMes = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
      if (anoInt % 4 === 0 && (anoInt % 100 !== 0 || anoInt % 400 === 0)) {
        diasPorMes[2] = 29; // Ano bissexto
      }
      if (diaInt > diasPorMes[mesInt]) continue;

      // Retorna no formato YYYY-MM-DD
      return `${ano}-${mes}-${dia}`;
    }
  }

  return null;
}

// Função para calcular idade a partir da data de nascimento
function calcularIdade(dataNascimento) {
  if (!dataNascimento) return null;
  
  try {
    const hoje = new Date();
    const nascimento = new Date(dataNascimento);
    
    if (isNaN(nascimento.getTime())) return null;
    
    let idade = hoje.getFullYear() - nascimento.getFullYear();
    const mesAtual = hoje.getMonth();
    const mesNascimento = nascimento.getMonth();
    
    if (mesAtual < mesNascimento || (mesAtual === mesNascimento && hoje.getDate() < nascimento.getDate())) {
      idade--;
    }
    
    return idade > 0 ? idade : null;
  } catch (error) {
    return null;
  }
}

async function processarAnexos(response) {
  try {
    const answers = Array.isArray(response.answers) ? response.answers : [];
    const campoCurriculo = answers.find(a =>
      a?.type === 'file_url' && a?.file_url && a?.field && IDS_CURRICULO.includes(a.field.id)
    ) || answers.find(a => a?.type === 'file_url' && a?.file_url);

    if (!campoCurriculo) return null;

    const fileUrl = campoCurriculo.file_url;
    const fileName = fileUrl.split('/').pop();
    const ext = fileName.split('.').pop().toLowerCase();

    let contentType = 'application/octet-stream';
    if (ext === 'pdf') contentType = 'application/pdf';
    if (['jpg', 'jpeg'].includes(ext)) contentType = 'image/jpeg';
    if (ext === 'png') contentType = 'image/png';

    const resposta = await fetch(fileUrl, {
      headers: { Authorization: `Bearer ${process.env.TYPEFORM_TOKEN}` }
    });
    if (!resposta.ok) return null;

    const buffer = await resposta.buffer();
    const sanitizedFileName = sanitizeFilename(fileName);

    const { data, error } = await supabase.storage.from('curriculo').upload(
      `${response.response_id}/${sanitizedFileName}`,
      buffer,
      { contentType, upsert: true, cacheControl: '3600' }
    );
    if (error) return null;

    return `${response.response_id}/${sanitizedFileName}`;
  } catch (error) {
    return null;
  }
}

// Configuração de timeout para fetch
const fetchWithTimeout = async (url, options = {}, timeout = 30000) => {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    clearTimeout(id);
    return response;
  } catch (error) {
    clearTimeout(id);
    throw error;
  }
};

// Função para adicionar delay entre requisições
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fetchAllResponses() {
  let allResponses = [];
  try {
    for (const formId of FORM_IDS) {
      console.log(`📥 Buscando respostas do formulário ${formId}...`);
      let page = 1;
      const MAX_PAGES = 5; // Limite máximo de páginas por segurança
      
      while (page <= MAX_PAGES) {
        console.log(`   Página ${page}...`);
        try {
          const res = await fetchWithTimeout(
            `https://api.typeform.com/forms/${formId}/responses?page_size=200&page=${page}`,
            { headers: { Authorization: `Bearer ${process.env.TYPEFORM_TOKEN}` } }
          );
          
          if (!res.ok) {
            console.error(`   ❌ Erro HTTP ${res.status} na página ${page}`);
            throw new Error(`HTTP ${res.status}`);
          }
          
          const data = await res.json();
          console.log(`   📊 Resposta da API:
            - Total de itens: ${data.items?.length || 0}
            - Total de páginas: ${data.page_count || 'N/A'}
            - Itens por página: ${data.items_per_page || 'N/A'}
            - Total de respostas: ${data.total_items || 'N/A'}`);
          
          if (!data.items || data.items.length === 0) {
            console.log('   ✅ Nenhuma resposta encontrada, finalizando paginação');
            break;
          }
          
          allResponses = [
            ...allResponses,
            ...data.items.map((item) => {
              if (!item) {
                console.warn('   ⚠️ Item nulo encontrado, pulando...');
                return null;
              }

              // A nova estrutura tem as propriedades diretamente no item
              return {
                form_id: formId, // Usamos o formId do loop atual
                response_id: item.response_id,
                answers: item.answers || [],
                raw: item // opcional
              };
            }).filter(Boolean)
          ];
          
          console.log(`   ✅ ${data.items.length} respostas encontradas (Total acumulado: ${allResponses.length})`);
          
          // Verifica se chegou na última página
          if (page >= (data.page_count || 1)) {
            console.log('   ✅ Última página atingida');
            break;
          }
          
          // Adiciona delay de 1 segundo entre requisições
          await delay(1000);
          page++;
          
        } catch (error) {
          console.error(`   ❌ Erro na página ${page}:`, error.message);
          await delay(5000);
          continue;
        }
      }
      
      console.log(`\n📊 Resumo do formulário ${formId}:
        - Total de respostas encontradas: ${allResponses.length}
        - Páginas processadas: ${page - 1}`);
    }
  } catch (error) {
    console.error('❌ Erro ao buscar respostas:', error.message);
    throw error;
  }
  return allResponses;
}

console.time('⏱ Tempo total');
console.log('🚀 Iniciando processamento de candidaturas...');

async function processarCandidatura(response) {
  try {
    console.log(`\n📝 Processando candidatura ${response.response_id}`);

    const caminhoCurriculo = await processarAnexos(response);
    const dados_estruturados = await estruturarDados(response);

    if (!dados_estruturados || typeof dados_estruturados !== 'object') {
      console.warn(`⚠️ Estruturação inválida para ${response.response_id}, pulando...`);
      return false;
    }

    let vaga_nome = dados_estruturados?.profissional?.vaga || null;

    if (!vaga_nome) {
      const respostaVaga = response.answers.find(ans =>
        ans?.field?.ref === 'a347f0fa-431c-4f86-8ffe-3239e8f1b800' ||
        ans?.field?.id === 'JNuaMlqdlJkT'
      );
      vaga_nome = respostaVaga?.choice?.label?.trim() || null;
    }

    let requisitosVaga = null;
    if (vaga_nome) {
      const vaga_normalizada = normalizeText(vaga_nome);
      const { data: todasVagas } = await supabase.from('requisitos').select('*');
      requisitosVaga = todasVagas.find(v => normalizeText(v.vaga_nome) === vaga_normalizada);
    }

    const prompt = requisitosVaga
      ? `Vaga: ${vaga_nome}\nRequisitos: ${requisitosVaga.requisito}\nDiferenciais: ${requisitosVaga.diferencial}\n${caminhoCurriculo ? `\nCurrículo: ${caminhoCurriculo}` : ''}\nAnalise se o candidato atende aos requisitos. Dê um score de 0 a 100.`
      : `Dados do candidato:\n${JSON.stringify(dados_estruturados, null, 2)}`;

    const analise = await analisarCandidatura({ ...response, prompt_custom: prompt }, caminhoCurriculo, requisitosVaga);

    const nome = extrairCampoTextoPorId(response.form_id, response.answers, MAPA_CAMPOS, 'nome') || 'Não identificado';
    const cpf = extrairCampoTextoPorId(response.form_id, response.answers, MAPA_CAMPOS, 'cpf');
    const telefone = extrairCampoTextoPorId(response.form_id, response.answers, MAPA_CAMPOS, 'telefone');
    const email = extrairCampoTextoPorId(response.form_id, response.answers, MAPA_CAMPOS, 'email');
    
    // Extrair data de nascimento
    const dataNascimentoTexto = extrairCampoTextoPorId(response.form_id, response.answers, MAPA_CAMPOS, 'dataNascimento');
    const dataNascimento = dataNascimentoTexto ? extrairDataNascimento(dataNascimentoTexto) : null;
    const idade = dataNascimento ? calcularIdade(dataNascimento) : null;

    if (!dados_estruturados.pessoal) dados_estruturados.pessoal = {};
    dados_estruturados.pessoal.nome = nome;
    dados_estruturados.pessoal.cpf = cpf;
    dados_estruturados.pessoal.telefone = telefone;
    dados_estruturados.pessoal.email = email;
    dados_estruturados.pessoal.data_nascimento = dataNascimento;
    dados_estruturados.pessoal.idade = idade;

    // Log para debug
    if (dataNascimentoTexto) {
      console.log(`   📅 Data de nascimento extraída: "${dataNascimentoTexto}" -> "${dataNascimento}" (Idade: ${idade})`);
    } else {
      console.log(`   ⚠️ Campo de data de nascimento não encontrado`);
    }

    const { error: upsertError } = await supabase.from('candidaturas').upsert({
      response_id: response.response_id,
      raw_data: response,
      dados_estruturados,
      analise_ia: analise,
      curriculo_path: caminhoCurriculo,
      tem_curriculo: !!caminhoCurriculo,
      updated_at: new Date().toISOString(),
      status: response.status || 'Analisado por IA',
      nome
    }, { onConflict: 'response_id' });

    if (upsertError) {
      console.error(`❌ Erro no upsert response_id ${response.response_id}:`, upsertError);
      return false;
    }

    return true;
  } catch (error) {
    console.error(`❌ Erro ao processar candidatura ${response.response_id}:`, error);
    return false;
  }
}

async function main() {
  try {
    console.log('🚀 Iniciando processamento de candidaturas...');
    console.log('⏳ Buscando respostas do Typeform...');
    const responses = (await fetchAllResponses()).map((r) => {
      const base = r.form_response || r;
      return {
        ...base,
        form_id: base.form_id,
        response_id: base.response_id,
        answers: base.answers || [],
      };
    });
    console.log(`✅ Total de ${responses.length} respostas encontradas`);

    console.log('⏳ Buscando candidaturas já analisadas...');
    const { data: analisados, error: erroAnalisados } = await supabase
      .from('candidaturas')
      .select('response_id')
      .not('analise_ia', 'is', null);

    if (erroAnalisados) {
      console.error('[ERRO] ao buscar analisados:', erroAnalisados);
      throw erroAnalisados;
    }

    const ignorarIds = (analisados || []).map(c => c.response_id);
    // Só processa a partir do 502º candidato da lista total
    const responsesApartir502 = responses.slice(501);
    // Agora filtra só os que ainda não foram analisados
    let novasCandidaturas = responsesApartir502.filter(r => !ignorarIds.includes(r.response_id));
    console.log(`⏳ Processando ${novasCandidaturas.length} novas candidaturas...`);
    console.log(`📊 Detalhes:
    - Total de respostas: ${responses.length}
    - Já analisadas: ${ignorarIds.length}
    - Novas para processar: ${novasCandidaturas.length}
    - IDs ignorados: ${ignorarIds.length}`);

    let processadas = 0;
    let erros = 0;
    const SKIP_COUNT = 0; // Processa todas as novas candidaturas

    // Processa em lotes de 10 candidaturas
    const BATCH_SIZE = 10;
    for (let i = SKIP_COUNT; i < novasCandidaturas.length; i += BATCH_SIZE) {
      const batch = novasCandidaturas.slice(i, i + BATCH_SIZE);
      console.log(`\n📦 Processando lote ${Math.floor(i/BATCH_SIZE) + 1}/${Math.ceil(novasCandidaturas.length/BATCH_SIZE)}`);
      console.log(`   Índice atual: ${i}, Total disponível: ${novasCandidaturas.length}`);

      for (const response of batch) {
        try {
          const candidatura = await processarCandidatura(response);
          if (candidatura) {
            processadas++;
            console.log(`✅ Candidatura ${response.response_id} processada com sucesso`);
          } else {
            erros++;
            console.log(`⚠️ Candidatura ${response.response_id} não foi processada`);
          }
        } catch (error) {
          console.error(`❌ Erro candidatura ${response.response_id}:`, error.message);
          erros++;
        }
      }

      // Mostra uso de memória após cada lote
      const used = process.memoryUsage();
      console.log(`\n📊 Uso de memória após lote: ${Math.round(used.heapUsed / 1024 / 1024)}MB`);
      
      // Adiciona delay entre lotes
      if (i + BATCH_SIZE < novasCandidaturas.length) {
        console.log('⏳ Aguardando 5 segundos antes do próximo lote...');
        await delay(5000);
      }
    }

    console.log('\n🎉 Fim do processamento.');
    console.log(`📊 Resumo:
    - Total de candidaturas: ${responses.length}
    - Já analisadas: ${ignorarIds.length}
    - Processadas: ${processadas}
    - Erros: ${erros}`);
  } catch (error) {
    console.error('💥 Erro fatal:', error.message);
    process.exit(1);
  }
}

main();

module.exports = {
  extrairDataNascimento,
  calcularIdade,
  extrairCampoTextoPorId,
  normalizeText,
  MAPA_CAMPOS,
  sanitizeFilename,
  processarAnexos,
  fetchAllResponses,
  processarCandidatura,
  main
};