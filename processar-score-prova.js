require('dotenv').config();
const supabase = require('./supabaseClient');
const readline = require('readline');

// Função utilitária para normalizar nomes (igual frontend)
function normalizeText(text) {
  return (text || '')
    .normalize('NFD')
    .replace(/\u0300-\u036f/g, '')
    .replace(/[\u2013\u2014\u2015]/g, '-')
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();
}

function normalizeCpf(cpf) {
  return (cpf || '').replace(/\D/g, '');
}

// Função principal
async function main() {
  console.log('Cole o payload do Typeform (JSON) e pressione Enter duas vezes:');
  let input = '';
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
  });

  rl.on('line', (line) => {
    if (line.trim() === '' && input.trim() !== '') {
      rl.close();
    } else {
      input += line + '\n';
    }
  });

  rl.on('close', async () => {
    let payload;
    try {
      payload = JSON.parse(input);
    } catch (e) {
      console.error('Erro ao fazer parse do JSON:', e.message);
      process.exit(1);
    }

    let nome = null;
    let score = null;
    let cpf = null;

    // Extrai nome, score e cpf do payload (ajuste conforme o formato real)
    if (payload.nome) nome = payload.nome;
    if (payload.score) score = payload.score;
    if (payload.cpf) cpf = payload.cpf;

    // Se vier no formato de answers (Typeform)
    if (Array.isArray(payload.answers)) {
      if (!nome) {
        const nomeField = payload.answers.find(a => (a.field?.id || a.field?.ref || '').toLowerCase().includes('nome'));
        if (nomeField) nome = nomeField.text || nomeField.value;
      }
      if (!score) {
        const scoreField = payload.answers.find(a => {
          const key = (a.field?.id || a.field?.ref || '').toLowerCase();
          return key.includes('score') || key.includes('nota') || key.includes('pontuacao');
        });
        if (scoreField) score = scoreField.number || scoreField.text || scoreField.value;
      }
      if (!cpf) {
        const cpfField = payload.answers.find(a => (a.field?.id || a.field?.ref || '').toLowerCase().includes('cpf'));
        if (cpfField) cpf = cpfField.text || cpfField.value;
      }
    }

    if (!nome && !cpf) {
      console.error('Não foi possível extrair nome nem CPF do payload.');
      process.exit(1);
    }
    if (!score) {
      console.error('Não foi possível extrair score do payload.');
      process.exit(1);
    }

    console.log('Nome extraído:', nome);
    console.log('CPF extraído:', cpf);
    console.log('Score extraído:', score);

    // Busca o candidato pelo nome (normalizado)
    let candidato = null;
    let buscaPor = '';
    if (nome) {
      const nomeNormalizado = normalizeText(nome);
      const { data: candidatos, error } = await supabase
        .from('candidaturas')
        .select('id, nome, score_prova, status, cpf')
        .limit(30);
      if (error) {
        console.error('Erro ao buscar candidatos:', error.message);
        process.exit(1);
      }
      candidato = (candidatos || []).find(c => normalizeText(c.nome) === nomeNormalizado);
      if (candidato) buscaPor = 'nome';
    }
    // Se não achou por nome, tenta por CPF
    if (!candidato && cpf) {
      const cpfNormalizado = normalizeCpf(cpf);
      const { data: candidatosCpf, error: errorCpf } = await supabase
        .from('candidaturas')
        .select('id, nome, score_prova, status, cpf')
        .eq('cpf', cpfNormalizado)
        .limit(2);
      if (errorCpf) {
        console.error('Erro ao buscar por CPF:', errorCpf.message);
        process.exit(1);
      }
      if (candidatosCpf && candidatosCpf.length > 0) {
        candidato = candidatosCpf[0];
        buscaPor = 'cpf';
      }
    }

    if (!candidato) {
      console.error('Candidato não encontrado por nome nem CPF.');
      process.exit(1);
    }

    console.log(`Candidato encontrado por ${buscaPor}: ${candidato.nome} (id: ${candidato.id})`);

    // Atualiza apenas o score_prova, mantém o status atual
    const { error: updateError } = await supabase
      .from('candidaturas')
      .update({ score_prova: score })
      .eq('id', candidato.id);

    if (updateError) {
      console.error('Erro ao atualizar score_prova:', updateError.message);
      process.exit(1);
    }

    console.log(`Score atualizado com sucesso para o candidato ${candidato.nome} (id: ${candidato.id})!`);
    process.exit(0);
  });
}

main(); 