// ... início do arquivo
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');
const { analisarCandidatura, estruturarDados } = require('./services/openai-analise');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { db: { schema: 'public' } }
);

const FORM_IDS = ['ynFUyrAc', 'i6GB06nW', 'OejwZ32V'];

function sanitizeFilename(filename) {
  return filename
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9._-]/g, '_');
}

function normalizeText(text) {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // remove acentos
    .replace(/[–—―]/g, '-') // substitui travessões por hífen
    .replace(/[^\w\s-]/g, '') // remove emojis e símbolos
    .replace(/\s+/g, ' ') // espaço único
    .toLowerCase()
    .trim();
}

async function processarAnexos(response) {
  try {
    console.log(`[DEBUG] Resposta ${response.response_id} - answers:`, JSON.stringify(response.answers, null, 2));

    const campoCurriculo = response.answers.find(a => a.field.id === 'dmlXVJZuZ7BH');
    if (!campoCurriculo || campoCurriculo.type !== 'file_url' || !campoCurriculo.file_url) {
      console.log(`[CURRICULO] Resposta ${response.response_id}: Campo de currículo não encontrado ou sem URL.`);
      return null;
    }

    const fileUrl = campoCurriculo.file_url;
    const fileName = fileUrl.split('/').pop();
    const ext = fileName.split('.').pop().toLowerCase();

    let contentType = 'application/octet-stream';
    if (ext === 'pdf') contentType = 'application/pdf';
    if (['jpg', 'jpeg'].includes(ext)) contentType = 'image/jpeg';
    if (ext === 'png') contentType = 'image/png';

    console.log(`[CURRICULO] Resposta ${response.response_id}: Baixando ${fileName} (${fileUrl})...`);
    const resposta = await fetch(fileUrl, {
      headers: { Authorization: `Bearer ${process.env.TYPEFORM_TOKEN}` }
    });
    if (!resposta.ok) {
      console.log(`[CURRICULO] Erro ao baixar: ${resposta.status}`);
      return null;
    }

    const buffer = await resposta.buffer();
    const sanitizedFileName = sanitizeFilename(fileName);

    const { data, error } = await supabase.storage.from('curriculo').upload(
      `${response.response_id}/${sanitizedFileName}`,
      buffer,
      { contentType, upsert: true, cacheControl: '3600' }
    );
    if (error) {
      console.log(`[CURRICULO] Upload erro:`, error.message);
      return null;
    }

    console.log(`[CURRICULO] Upload ok: ${response.response_id}/${sanitizedFileName}`);
    return `${response.response_id}/${sanitizedFileName}`;

  } catch (error) {
    console.error('Erro upload currículo:', error.message);
    return null;
  }
}




async function fetchAllResponses() {
  let allResponses = [];
  try {
    for (const formId of FORM_IDS) {
      let page = 1;
      while (true) {
        console.log('TOKEN:', JSON.stringify(process.env.TYPEFORM_TOKEN));
        const res = await fetch(
          `https://api.typeform.com/forms/${formId}/responses?page_size=200&page=${page}`,
          { headers: { Authorization: `Bearer ${process.env.TYPEFORM_TOKEN}` } }
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        allResponses = [...allResponses, ...(data.items || [])];
        if (!data.items || data.items.length < 200) break;
        page++;
      }
    }
  } catch (error) {
    console.error('Erro fetch responses:', error.message);
    throw error;
  }
  return allResponses;
}

async function main() {
  try {
    const responses = await fetchAllResponses();
    console.log(`📥 Total de candidaturas: ${responses.length}`);

    for (const [index, response] of responses.entries()) {
      try {
        const { data: existente } = await supabase
          .from('candidaturas')
          .select('analise_ia')
          .eq('response_id', response.response_id)
          .maybeSingle();

        if (existente?.analise_ia) {
          console.log(`⏩ ${index + 1}/${responses.length} Já analisado: ${response.response_id}`);
          continue;
        }

        console.log(`⏳ Processando ${index + 1}/${responses.length}`);
        const caminhoCurriculo = await processarAnexos(response);
        let dados_estruturados = null;
        try {
          dados_estruturados = await estruturarDados(response);
        } catch (e) {
          console.error('Erro estruturar dados:', e.message);
        }

        let vaga_nome = dados_estruturados?.profissional?.vaga;
        if (!vaga_nome) {
          const respostaVaga = response.answers.find(ans =>
            ans.field?.ref === 'a347f0fa-431c-4f86-8ffe-3239e8f1b800' ||
            ans.field?.id === 'JNuaMlqdlJkT'
          );
          vaga_nome = respostaVaga?.choice?.label?.trim() || null;
          console.log(`[DEBUG] vaga_nome direto do Typeform: "${vaga_nome}"`);
        }

        let requisitosVaga = null;
        if (vaga_nome) {
          try {
            const vaga_normalizada = normalizeText(vaga_nome);
            const { data: todasVagas, error: erroTodas } = await supabase
              .from('requisitos')
              .select('*');

            if (erroTodas) {
              console.error('Erro ao buscar vagas:', erroTodas.message);
            } else {
              requisitosVaga = todasVagas.find(v =>
                normalizeText(v.vaga_nome) === vaga_normalizada
              );
              if (!requisitosVaga) {
                console.warn(`[REGRAS] Nenhum match para vaga: "${vaga_nome}"`);
              } else {
                console.log(`[REGRAS] Match: "${requisitosVaga.vaga_nome}"`);
                requisitosVaga.requisito = requisitosVaga.requisito?.trim() || '';
                requisitosVaga.diferencial = requisitosVaga.diferencial?.trim() || '';
              }
            }
          } catch (e) {
            console.error('Erro comparação vaga:', e.message);
          }
        }

        if (!dados_estruturados) dados_estruturados = {};
        if (!dados_estruturados.profissional) dados_estruturados.profissional = {};

        dados_estruturados.profissional.vaga = vaga_nome;
        dados_estruturados.profissional.requisitosArr = requisitosVaga?.requisito
          ? requisitosVaga.requisito.split('\n').map(r => r.trim()).filter(Boolean)
          : [];
        dados_estruturados.profissional.diferenciaisArr = requisitosVaga?.diferencial
          ? requisitosVaga.diferencial.split('\n').map(d => d.trim()).filter(Boolean)
          : [];
        dados_estruturados.profissional.tituloVaga = requisitosVaga?.vaga_nome || vaga_nome;

        console.log('DEBUG - requisitosArr:', dados_estruturados.profissional.requisitosArr);
        console.log('DEBUG - diferenciaisArr:', dados_estruturados.profissional.diferenciaisArr);
        console.log('DEBUG - tituloVaga:', dados_estruturados.profissional.tituloVaga);
        console.log('DEBUG - vaga_nome extraído:', dados_estruturados.profissional.vaga);

        const prompt = requisitosVaga
          ? `Vaga: ${vaga_nome}\nRequisitos: ${requisitosVaga.requisito}\nDiferenciais: ${requisitosVaga.diferencial}\n` +
            (caminhoCurriculo ? `\nCurrículo: ${caminhoCurriculo}` : '') +
            `\nAnalise se o candidato atende aos requisitos. Dê um score de 0 a 100.`
          : `Dados do candidato:\n${JSON.stringify(dados_estruturados, null, 2)}`;

        let analise = null;
        try {
          analise = await analisarCandidatura({ ...response, prompt_custom: prompt }, caminhoCurriculo, requisitosVaga);
        } catch (e) {
          console.error('Erro análise IA:', e.message);
        }

        let nome = dados_estruturados?.pessoal?.nome || 'Não identificado';
        if (nome.toLowerCase() === 'texto' || nome.length < 2) {
          const nomeCampo = response.answers.find(a => a.field?.id === '6VkDMDJph5Jc');
          nome = nomeCampo?.text || nome;
        }

        const { error } = await supabase.from('candidaturas').upsert({
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
          console.error('Erro salvar no Supabase:', error.message);
        } else {
          console.log(`✅ ${index + 1}/${responses.length} OK: ${response.response_id}`);
        }

      } catch (error) {
        console.error(`⚠️ Erro candidatura ${response.response_id}:`, error.message);
      }
    }

    console.log('🎉 Fim do processamento.');
  } catch (error) {
    console.error('💥 Erro fatal:', error.message);
    process.exit(1);
  }
}

main();