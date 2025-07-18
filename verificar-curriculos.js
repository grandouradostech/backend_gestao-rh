require('dotenv').config();
const supabase = require('./supabaseClient');

async function verificarCurriculos() {
  try {
    console.log('🔍 Verificando currículos no banco de dados...');
    
    // Buscar todos os candidatos com currículo
    const { data: candidatos, error } = await supabase
      .from('candidaturas')
      .select('id, nome, curriculo_path, dados_estruturados')
      .not('curriculo_path', 'is', null);
    
    if (error) {
      console.error('Erro ao buscar candidatos:', error);
      return;
    }
    
    console.log(`📊 Encontrados ${candidatos.length} candidatos com currículo`);
    
    let corrigidos = 0;
    let erros = 0;
    
    for (const candidato of candidatos) {
      try {
        const curriculoPath = candidato.curriculo_path;
        
        // Se já é uma URL completa, verificar se está funcionando
        if (curriculoPath.startsWith('http')) {
          console.log(`✅ ${candidato.nome}: URL já está correta`);
          continue;
        }
        
        // Se é apenas o caminho, gerar URL pública
        if (curriculoPath.includes('/')) {
          const { data: { publicUrl } } = supabase.storage
            .from('curriculos')
            .getPublicUrl(curriculoPath);
          
          if (publicUrl) {
            // Atualizar no banco
            const { error: updateError } = await supabase
              .from('candidaturas')
              .update({ curriculo_path: publicUrl })
              .eq('id', candidato.id);
            
            if (updateError) {
              console.error(`❌ Erro ao atualizar ${candidato.nome}:`, updateError);
              erros++;
            } else {
              console.log(`✅ ${candidato.nome}: URL corrigida para ${publicUrl}`);
              corrigidos++;
            }
          } else {
            console.log(`⚠️ ${candidato.nome}: Não foi possível gerar URL pública para ${curriculoPath}`);
            erros++;
          }
        }
      } catch (error) {
        console.error(`❌ Erro ao processar ${candidato.nome}:`, error);
        erros++;
      }
    }
    
    console.log('\n📈 Resumo:');
    console.log(`✅ Corrigidos: ${corrigidos}`);
    console.log(`❌ Erros: ${erros}`);
    console.log(`📊 Total processados: ${candidatos.length}`);
    
  } catch (error) {
    console.error('Erro geral:', error);
  }
}

// Executar verificação
verificarCurriculos(); 