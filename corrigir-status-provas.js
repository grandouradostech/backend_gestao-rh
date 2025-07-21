require('dotenv').config();
const supabase = require('./supabaseClient');

async function corrigirStatusProvas() {
  console.log('Iniciando correção de status de provas...');
  
  try {
    // Buscar candidatos com status numérico (que deveriam estar em 'Provas')
    const { data: candidatos, error } = await supabase
      .from('candidaturas')
      .select('id, nome, status, score_prova, scores_provas')
      .or('status.eq.0,status.eq.10,status.eq.5,status.eq.8,status.eq.9,status.eq.7,status.eq.6,status.eq.4,status.eq.3,status.eq.2,status.eq.1');
    
    if (error) {
      console.error('Erro ao buscar candidatos:', error.message);
      return;
    }
    
    console.log(`Encontrados ${candidatos.length} candidatos com status numérico:`);
    
    let corrigidos = 0;
    let verificacaoManual = 0;
    
    for (const candidato of candidatos) {
      console.log(`\n- ${candidato.nome} (ID: ${candidato.id}): status atual = "${candidato.status}"`);
      
      // Verificar se tem score_prova ou scores_provas (indicando que fez provas)
      const temScore = candidato.score_prova || (candidato.scores_provas && Object.keys(candidato.scores_provas).length > 0);
      
      if (temScore) {
        // Se tem score, corrigir para 'Provas' (pois fez provas)
        const { error: updateError } = await supabase
          .from('candidaturas')
          .update({ status: 'Provas' })
          .eq('id', candidato.id);
        
        if (updateError) {
          console.error(`❌ Erro ao corrigir ${candidato.nome}:`, updateError.message);
        } else {
          console.log(`✅ Corrigido: ${candidato.nome} -> status: "Provas" (tem score: ${candidato.score_prova || 'scores_provas'})`);
          corrigidos++;
        }
      } else {
        // Se não tem score, pode ser um erro de digitação ou outro problema
        console.log(`⚠️  ${candidato.nome} não tem score de prova. Status "${candidato.status}" pode ser erro de digitação.`);
        console.log(`   Sugestão: Verificar se deveria estar em "Provas" ou outra etapa.`);
        verificacaoManual++;
      }
    }
    
    console.log(`\n📊 Resumo:`);
    console.log(`✅ Candidatos corrigidos: ${corrigidos}`);
    console.log(`⚠️  Candidatos para verificação manual: ${verificacaoManual}`);
    console.log(`\nCorreção concluída!`);
    
  } catch (err) {
    console.error('Erro inesperado:', err.message);
  }
}

corrigirStatusProvas(); 