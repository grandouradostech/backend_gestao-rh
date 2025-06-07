require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');
const { analisarCandidatura, estruturarDados } = require('./services/openai-analise');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY, {
    db: { schema: 'public' }
});

const FORM_IDS = ['ynFUyrAc', 'i6GB06nW', 'OejwZ32V'];

function sanitizeFilename(filename) {
  // Remove acentos e caracteres especiais
  return filename
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // remove acentos
    .replace(/[^a-zA-Z0-9._-]/g, '_'); // troca outros caracteres por _
}


async function processarAnexos(response) {
  try {
    // Log para debug do conteúdo de answers
    console.log(`[DEBUG] Resposta ${response.response_id} - answers:`, JSON.stringify(response.answers, null, 2));
    const campoCurriculo = response.answers.find(a => 
      a.field.id === 'dmlXVJZuZ7BH' // ID do campo de currículo
    );
    
    if (!campoCurriculo) {
      console.log(`[CURRICULO] Resposta ${response.response_id}: Campo de currículo não encontrado.`);
      return null;
    }
    if (campoCurriculo.type !== 'file_url' || !campoCurriculo.file_url) {
      console.log(`[CURRICULO] Resposta ${response.response_id}: Campo de currículo sem URL do arquivo.`);
      return null;
    }

    const fileUrl = campoCurriculo.file_url;
    const fileName = fileUrl.split('/').pop();
    const ext = fileName.split('.').pop().toLowerCase();

    // Detectar contentType simples
    let contentType = 'application/octet-stream';
    if (ext === 'pdf') contentType = 'application/pdf';
    if (['jpg', 'jpeg'].includes(ext)) contentType = 'image/jpeg';
    if (ext === 'png') contentType = 'image/png';

    console.log(`[CURRICULO] Resposta ${response.response_id}: Baixando arquivo ${fileName} (${fileUrl})...`);
    const resposta = await fetch(fileUrl, {
      headers: { Authorization: `Bearer ${process.env.TYPEFORM_TOKEN}` }
    });
    
    if (!resposta.ok) {
      console.log(`[CURRICULO] Resposta ${response.response_id}: Falha ao baixar arquivo do Typeform. Status: ${resposta.status}`);
      return null;
    }

    const buffer = await resposta.buffer();
    console.log(`[CURRICULO] Resposta ${response.response_id}: Upload para Supabase Storage...`);
    const sanitizedFileName = sanitizeFilename(fileName);
    const { data, error } = await supabase.storage
      .from('curriculo')
      .upload(
        `${response.response_id}/${sanitizedFileName}`,
        buffer,
        { 
          contentType,
          upsert: true,
          cacheControl: '3600'
        }
      );

    if (error) {
      console.log(`[CURRICULO] Resposta ${response.response_id}: Erro no upload para Supabase:`, error.message);
      return null;
    }
    console.log(`[CURRICULO] Resposta ${response.response_id}: Upload concluído em ${response.response_id}/${sanitizedFileName}`);
    return `${response.response_id}/${sanitizedFileName}`;
  } catch (error) {
    console.error('❌ Erro no upload do currículo:', error.message);
    return null;
  }
}

async function fetchAllResponses() {
  let allResponses = [];
  try {
    for (const formId of FORM_IDS) {
      let page = 1;
      while (true) {
        // Debug do token
        console.log('TOKEN:', JSON.stringify(process.env.TYPEFORM_TOKEN));
        const res = await fetch(
          `https://api.typeform.com/forms/${formId}/responses?page_size=200&page=${page}`,
          { headers: { Authorization: `Bearer ${process.env.TYPEFORM_TOKEN}` } }
        );
        if (!res.ok) throw new Error(`HTTP ${res.status} - ${res.statusText}`);
        const data = await res.json();
        allResponses = [...allResponses, ...(data.items || [])];
        if (!data.items || data.items.length < 200) break;
        page++;
      }
    }
  } catch (error) {
    console.error('🚨 Erro na busca de respostas:', error.message);
    throw error;
  }
  return allResponses;
}

function padronizarCidades(cidades) {
  return cidades
    .replace(/ e /gi, ',') // troca ' e ' por vírgula
    .replace(/[.]/g, '')   // remove pontos finais
    .toLowerCase()
    .trim();
}

function normalizeCity(city) {
  if (!city) return '';
  return city
    .normalize('NFD').replace(/[0-\u036f]/g, '') // remove acentos
    .replace(/\b(ms|sp|rj|mg|pr|sc|rs|es|ba|go|mt|pa|am|ap|rr|ro|ac|al|ce|ma|pb|pe|pi|rn|se|to)\b/gi, '') // remove siglas de estado
    .replace(/[\/\-]/g, ' ') // troca / e - por espaço
    .replace(/[^a-zA-Z0-9 ]/g, '') // remove outros caracteres especiais
    .replace(/\s+/g, ' ') // espaços múltiplos para um só
    .toLowerCase()
    .trim();
}

// Função para buscar resposta de CNH do candidato
function getRespostaCNH(dados_estruturados, response) {
  // Tente buscar em dados estruturados
  if (dados_estruturados?.profissional?.cnh) return dados_estruturados.profissional.cnh;
  // Ou busque no array de respostas do Typeform
  if (Array.isArray(response.answers)) {
    const cnhAnswer = response.answers.find(ans =>
      ans.field && (
        (ans.field.id && ans.field.id.toLowerCase().includes('cnh')) ||
        (ans.field.ref && ans.field.ref.toLowerCase().includes('cnh'))
      )
    );
    if (cnhAnswer && (cnhAnswer.text || cnhAnswer.choice?.label)) {
      return cnhAnswer.text || cnhAnswer.choice.label;
    }
  }
  return '';
}

async function main() {
  try {
    const responses = await fetchAllResponses();
    console.log(`📥 Total de candidaturas encontradas: ${responses.length}`);

    for (const [index, response] of responses.entries()) {
      try {
        // Verifica se já foi analisado
        const { data: existente, error: erroBusca } = await supabase
          .from('candidaturas')
          .select('analise_ia')
          .eq('response_id', response.response_id)
          .maybeSingle();
        if (erroBusca) {
          console.error(`Erro ao buscar candidato ${response.response_id}:`, erroBusca.message);
        }
        if (existente && existente.analise_ia) {
          console.log(`⏩ ${index + 1}/${responses.length} Já analisado, pulando: ${response.response_id}`);
          continue;
        }
        console.log(`⏳ Processando candidatura ${index + 1}/${responses.length}`);
        // Processar anexos
        const caminhoCurriculo = await processarAnexos(response);
        // Estruturar dados
        let dados_estruturados = null;
        try {
          dados_estruturados = await estruturarDados(response);
        } catch (e) {
          console.error('⚠️ Erro ao estruturar dados:', e.message);
        }
        // Buscar requisitos da vaga
        let vaga_nome = dados_estruturados?.profissional?.vaga || null;
        let requisitosVaga = null;
        if (vaga_nome) {
          const { data: reqs, error: reqsError } = await supabase
            .from('requisitos')
            .select('*')
            .ilike('vaga_nome', `%${vaga_nome}%`)
            .maybeSingle();
          if (reqsError) {
            console.error('Erro ao buscar requisitos:', reqsError.message);
          }
          requisitosVaga = reqs;
        }
        // Buscar resposta de CNH do candidato
        const respostaCNH = getRespostaCNH(dados_estruturados, response);
        // Detectar se a vaga exige CNH nos requisitos
        const exigeCNH = requisitosVaga?.requisito && requisitosVaga.requisito.toLowerCase().includes('cnh');
        // Verificação de cidade via IA
        const cidadeCandidato = normalizeCity(dados_estruturados?.pessoal?.cidade?.trim());
        const cidadesRequisito = (requisitosVaga?.cidades || '').trim()
          .split(',')
          .map(c => normalizeCity(c));
        // Verificação de cidade (primeiro compara normalizado)
        const cidadeCandidatoNorm = normalizeCity(cidadeCandidato);
        const cidadesRequisitoStr = typeof cidadesRequisito === 'string' ? cidadesRequisito : '';
        const cidadesRequisitoNorm = cidadesRequisitoStr
          .split(',')
          .map(c => normalizeCity(c));
        let cidadeValida = false;
        if (cidadeCandidatoNorm && cidadesRequisitoNorm.length > 0) {
          if (cidadesRequisitoNorm.some(c => c === cidadeCandidatoNorm)) {
            cidadeValida = true;
          } else {
            // Só aqui chama a IA para casos realmente ambíguos
            const promptCidade = `A cidade do candidato é: "${cidadeCandidato}". As cidades permitidas para a vaga são: [${cidadesRequisito}].\nConsidere variações, abreviações, siglas de estado, erros leves de digitação, acentuação e espaços. Responda apenas com SIM ou NÃO: A cidade do candidato corresponde a alguma das cidades permitidas?`;
            try {
              const respostaCidade = await analisarCandidatura({ ...response, prompt_custom: promptCidade }, null);
              const respostaStr = (typeof respostaCidade === 'string' ? respostaCidade : respostaCidade?.choices?.[0]?.message?.content || '').toLowerCase();
              if (respostaStr.includes('sim')) cidadeValida = true;
            } catch (e) {
              console.error('Erro na análise IA de cidade:', e.message);
            }
          }
        } else {
          cidadeValida = true; // Se não há cidade informada ou cidades permitidas, não bloqueia
        }
        if (!cidadeValida) {
          console.log(`🚫 ${index + 1}/${responses.length} Cidade '${cidadeCandidato}' não reconhecida como permitida para a vaga '${vaga_nome}'. Pulando candidato ${response.response_id}`);
          continue;
        }
        // Montar prompt para IA
        let prompt = '';
        if (requisitosVaga) {
          prompt = `Vaga: ${vaga_nome}\nRequisitos: ${requisitosVaga.requisito}\nDiferenciais: ${requisitosVaga.diferencial}\nCidades: ${requisitosVaga.cidades}\n\nResposta do candidato sobre CNH: "${respostaCNH}"\n`;
          if (exigeCNH) {
            prompt += `IMPORTANTE: Se a vaga exige CNH (qualquer categoria) e o candidato não possui CNH, informe isso claramente na análise, mas mantenha a pontuação de aderência normalmente.\n`;
          }
          if (caminhoCurriculo) {
            prompt += `\nCurrículo: (arquivo em ${caminhoCurriculo})`;
          }
          prompt += '\nAnalise se o candidato atende a cada requisito e diferencial. Dê um score de 0 a 100 de aderência à vaga e explique brevemente.';
        } else {
          prompt = `Dados do candidato:\n${JSON.stringify(dados_estruturados, null, 2)}\n`;
        }
        // Analisar candidatura
        let analise = null;
        try {
          analise = await analisarCandidatura({ ...response, prompt_custom: prompt }, caminhoCurriculo);
        } catch (e) {
          console.error('Erro na análise IA:', e.message);
        }
        // Extrair nome do candidato
        function nomeValido(nome) {
          if (!nome) return false;
          if (/^\d{11}$/.test(nome)) return false;
          if (/^\d{10,}$/.test(nome)) return false;
          if (nome.toLowerCase() === 'texto') return false;
          if (nome.length < 2) return false;
          return true;
        }
        let nome = dados_estruturados?.pessoal?.nome || '';
        if (!nomeValido(nome)) {
          // Busca nos campos do Typeform
          let nomeTypeform = null;
          if (Array.isArray(response.answers)) {
            const nomeAnswer = response.answers.find(ans => ans.field && (ans.field.id === 'oq4YGUe70Wk6' || ans.field.id === '6VkDMDJph5Jc'));
            if (nomeAnswer && nomeAnswer.text) {
              nomeTypeform = nomeAnswer.text;
            }
          }
          nome = nomeValido(nomeTypeform) ? nomeTypeform : 'Não identificado';
        }
        // Salvar no banco
        const { data, error } = await supabase
          .from('candidaturas')
          .upsert({
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
        if (error) {
          console.error('❌ Erro ao salvar no Supabase:', error.message);
        } else {
          console.log('✅ Salvo no Supabase:', data);
        }
        console.log(`✅ ${index + 1}/${responses.length} Processado: ${response.response_id}`);
      } catch (error) {
        console.error(`⚠️ Erro no processamento da candidatura ${response.response_id}:`, error.message);
      }
    }
    console.log('🎉 Processamento concluído com sucesso!');
  } catch(error) {
    console.error('💥 Erro crítico:', error.message);
    process.exit(1);
  }
}

main();