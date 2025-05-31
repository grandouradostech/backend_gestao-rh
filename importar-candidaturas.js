require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');
const { analisarCandidatura, estruturarDados } = require('./services/openai-analise');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY, {
    db: { schema: 'public' }
});

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
    const { data, error } = await supabase.storage
      .from('curriculo')
      .upload(
        `${response.response_id}/${fileName}`,
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
    console.log(`[CURRICULO] Resposta ${response.response_id}: Upload concluído em ${response.response_id}/${fileName}`);
    return `${response.response_id}/${fileName}`;
  } catch (error) {
    console.error('❌ Erro no upload do currículo:', error.message);
    return null;
  }
}

async function fetchAllResponses() {
  let allResponses = [];
  let page = 1;
  
  try {
    while(true) {
      const res = await fetch(
        `https://api.typeform.com/forms/${process.env.TYPEFORM_FORM_ID}/responses?page_size=200&page=${page}`,
        { headers: { Authorization: `Bearer ${process.env.TYPEFORM_TOKEN}` } }
      );
      
      if (!res.ok) throw new Error(`HTTP ${res.status} - ${res.statusText}`);
      
      const data = await res.json();
      allResponses = [...allResponses, ...(data.items || [])];
      
      if (!data.items || data.items.length < 200) break;
      page++;
    }
  } catch(error) {
    console.error('🚨 Erro na busca de respostas:', error.message);
    throw error;
  }
  
  return allResponses;
}

async function main() {
  try {
    const responses = await fetchAllResponses();
    console.log(`📥 Total de candidaturas encontradas: ${responses.length}`);

    for (const [index, response] of responses.entries()) {
      try {
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
        // Analisar candidatura
        const analise = await analisarCandidatura(response, caminhoCurriculo);

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
        const { error } = await supabase
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

        if (error) throw error;
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