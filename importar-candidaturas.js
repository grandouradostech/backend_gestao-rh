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
    nome: ['6VkDMDJph5Jc', 'oq4YGUe70Wk6'], // novo id
    cpf: ['kyDMKvIiREJN', 'ZfxImfwRovM8'], // novo id
    telefone: ['ryREsjI6ocDM', 'YSBd6MMq285s'], // novo id
    email: ['0H5FhjQdZsUU', '7Ug3CCMc1sbO'], // novo id
    dataNascimento: ['YjlVPbYIjF5L', 'f7YAciExO7du', '04129866-6b88-478a-9a60-83f3157e5788']
  },
  i6GB06nW: {
    nome: ['c0SRbHskERPD', 'oq4YGUe70Wk6'], // novo id
    cpf: ['8vaBwiO7kELZ', 'ZfxImfwRovM8'], // novo id
    telefone: ['lXkYZdgtJuCM', 'YSBd6MMq285s'], // novo id
    email: ['DRrZHCUp0EhV', '7Ug3CCMc1sbO'], // novo id
    dataNascimento: ['ZfxImfwRovM8', 'f7YAciExO7du', '04129866-6b88-478a-9a60-83f3157e5788']
  },
  OejwZ32V: {
    nome: ['w0kqjkpQ8Oav', 'oq4YGUe70Wk6'], // novo id
    cpf: ['xWO9ZhqjMIsx', 'ZfxImfwRovM8'], // novo id
    telefone: ['mraynQBpbAew', 'YSBd6MMq285s'], // novo id
    email: ['djlTJfSHbAA4', '7Ug3CCMc1sbO'], // novo id
    dataNascimento: ['MZeKTR2jRuVF', 'f7YAciExO7du', '04129866-6b88-478a-9a60-83f3157e5788']
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

  // Fallback: se não achou, tenta encontrar qualquer campo do tipo 'text' que pareça uma data
  if (!resposta && nomeCampo === 'dataNascimento') {
    resposta = answers.find(a => {
      if (a?.type === 'text' && typeof a.value === 'string') {
        // Padrão: DDMMYYYY, DD/MM/YYYY, YYYY-MM-DD, etc
        return /^(\d{2}[\/\-]?\d{2}[\/\-]?\d{4}|\d{4}[\/\-]?\d{2}[\/\-]?\d{2})$/.test(a.value.trim());
      }
      return false;
    });
    if (resposta) {
      console.log('   ⚠️ Campo de data de nascimento encontrado por fallback:', resposta);
    }
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
                resposta.value ||
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

// Função robusta para parsear datas de nascimento em múltiplos formatos
function extrairDataNascimento(valor) {
  if (!valor) return null;
  valor = valor.trim();
  // DD/MM/YYYY ou D/M/YYYY
  let m = valor.match(/^([0-9]{1,2})\/([0-9]{1,2})\/([0-9]{4})$/);
  if (m) {
    const [_, d, mth, y] = m;
    // Se dia > 12, provavelmente é formato brasileiro
    if (parseInt(d, 10) > 12) {
      return `${y}-${mth.padStart(2, '0')}-${d.padStart(2, '0')}`;
    }
    // Se mês > 12, provavelmente é formato americano invertido
    if (parseInt(mth, 10) > 12) {
      return `${y}-${d.padStart(2, '0')}-${mth.padStart(2, '0')}`;
    }
    // Se ambos <= 12, pode ser ambíguo, mas prioriza brasileiro
    return `${y}-${mth.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  // YYYY-MM-DD
  m = valor.match(/^([0-9]{4})-([0-9]{2})-([0-9]{2})$/);
  if (m) {
    return valor;
  }
  // YYYY/MM/DD
  m = valor.match(/^([0-9]{4})\/([0-9]{2})\/([0-9]{2})$/);
  if (m) {
    return `${m[1]}-${m[2]}-${m[3]}`;
  }
  // Se não reconheceu, retorna null
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

    // Buscar definição do formulário para criar histórico legível
    let historicoRespostas = null;
    try {
      const formDefResponse = await fetch(`https://api.typeform.com/forms/${response.form_id}`, {
        headers: { Authorization: `Bearer ${process.env.TYPEFORM_TOKEN}` }
      });
      
      if (formDefResponse.ok) {
        const formDefinition = await formDefResponse.json();
        if (response.answers && formDefinition.fields) {
          historicoRespostas = criarHistoricoLegivel(response.answers, formDefinition.fields);
          console.log(`   📋 Histórico de respostas criado para ${response.response_id}`);
        }
      }
    } catch (e) {
      console.warn(`   ⚠️ Não foi possível criar histórico para ${response.response_id}:`, e.message);
    }

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

    // Preparar informações de tokens para salvar
    const tokensGastos = {
      analise: analise.tokens_gastos || null,
      estruturacao: dados_estruturados?.tokens_estruturacao || null,
      total_tokens: (analise.tokens_gastos?.total_tokens || 0) + (dados_estruturados?.tokens_estruturacao?.total_tokens || 0),
      timestamp: new Date().toISOString()
    };

    console.log(`   💰 Tokens gastos - Análise: ${analise.tokens_gastos?.total_tokens || 0}, Estruturação: ${dados_estruturados?.tokens_estruturacao?.total_tokens || 0}, Total: ${tokensGastos.total_tokens}`);

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
      tokens_gastos: tokensGastos,
      curriculo_path: caminhoCurriculo,
      tem_curriculo: !!caminhoCurriculo,
      updated_at: new Date().toISOString(),
      status: response.status || 'Analisado por IA',
      nome,
      historico_respostas: historicoRespostas || null
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
    
    // Filtrar apenas candidatos recentes (menos de 7 dias)
    const agora = new Date();
    const responsesRecentes = responses.filter(r => {
      if (!r.raw || !r.raw.submitted_at) {
        console.warn(`⚠️ Resposta sem data de submissão: ${r.response_id}`);
        return false; // Ignora se não tem data
      }
      
      const dataSubmissao = new Date(r.raw.submitted_at);
      const diffDias = (agora - dataSubmissao) / (1000 * 60 * 60 * 24);
      
      return diffDias <= 7; // Só candidatos com menos de 7 dias
    });
    
    // Agora filtra só os que ainda não foram analisados
    let novasCandidaturas = responsesRecentes.filter(r => !ignorarIds.includes(r.response_id));
    console.log(`⏳ Processando ${novasCandidaturas.length} novas candidaturas...`);
    console.log(`📊 Detalhes:
    - Total de respostas: ${responses.length}
    - Candidatos recentes (≤7 dias): ${responsesRecentes.length}
    - Já analisadas: ${ignorarIds.length}
    - Novas para processar: ${novasCandidaturas.length}`);

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
          // Checagem de duplicidade de CPF antes de processar
          const cpfNovo = extrairCampoTextoPorId(response.form_id, response.answers, MAPA_CAMPOS, 'cpf');
          let existeCpf = false;
          if (cpfNovo) {
            const { data: candidatosCpf, error: erroCpf } = await supabase
              .from('candidaturas')
              .select('id')
              .eq('dados_estruturados->pessoal->>cpf', cpfNovo);
            if (!erroCpf && candidatosCpf && candidatosCpf.length > 0) {
              existeCpf = true;
            }
          }
          if (existeCpf) {
            console.log(`⚠️ Candidato com CPF ${cpfNovo} já existe no sistema. Pulando response_id ${response.response_id}`);
            continue;
          }
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

// Função para criar histórico legível das respostas (mesma função do index.js)
function criarHistoricoLegivel(answers, fields) {
  const historico = {};
  const fieldMap = {};
  
  // Criar mapa de fields por ID
  fields.forEach(field => {
    fieldMap[field.id] = field.title || field.ref || `Campo ${field.type}`;
  });
  
  // Processar cada resposta
  answers.forEach(answer => {
    const fieldId = answer.field?.id;
    const fieldTitle = fieldMap[fieldId] || `Campo ${fieldId}`;
    
    let valorResposta = 'Sem resposta';
    
    // Extrair valor baseado no tipo de resposta
    if (answer.text) {
      valorResposta = answer.text;
    } else if (answer.email) {
      valorResposta = answer.email;
    } else if (answer.number !== undefined) {
      valorResposta = answer.number.toString();
    } else if (answer.boolean !== undefined) {
      valorResposta = answer.boolean ? 'Sim' : 'Não';
    } else if (answer.choice) {
      valorResposta = answer.choice.label || answer.choice;
    } else if (answer.choices) {
      valorResposta = Array.isArray(answer.choices.labels) 
        ? answer.choices.labels.join(', ') 
        : answer.choices;
    } else if (answer.date) {
      valorResposta = new Date(answer.date).toLocaleDateString('pt-BR');
    } else if (answer.phone_number) {
      valorResposta = answer.phone_number;
    } else if (answer.url) {
      valorResposta = answer.url;
    } else if (answer.file_url) {
      valorResposta = 'Arquivo anexado';
    }
    
    historico[fieldTitle] = valorResposta;
  });
  
  return historico;
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
  main,
  criarHistoricoLegivel
};