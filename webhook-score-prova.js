require('dotenv').config();
const express = require('express');
const supabase = require('./supabaseClient');

const app = express();
app.use(express.json());

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

function normalizeNomeParaComparacao(nome) {
  return (nome || '')
    .normalize('NFD')
    .replace(/\u0300-\u036f/g, '')
    .replace(/[^ -\w\s-]/g, '')
    .replace(/[\s]+/g, ' ')
    .toLowerCase()
    .trim();
}

function nomesParecidos(nomeA, nomeB) {
  if (!nomeA || !nomeB) return false;
  const a = normalizeNomeParaComparacao(nomeA);
  const b = normalizeNomeParaComparacao(nomeB);
  // Critério: um contém o outro ou similaridade >= 80% (simples)
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  // Similaridade simples: número de palavras iguais
  const palavrasA = a.split(' ');
  const palavrasB = b.split(' ');
  const iguais = palavrasA.filter(p => palavrasB.includes(p)).length;
  const minLen = Math.min(palavrasA.length, palavrasB.length);
  return minLen > 0 && (iguais / minLen) >= 0.8;
}

app.post('/webhook-score-prova', async (req, res) => {
  console.log('Payload recebido:', JSON.stringify(req.body, null, 2));
  try {
    const formResponse = req.body.form_response;
    if (!formResponse) {
      console.error('Payload não contém form_response');
      return res.status(400).json({ error: 'Payload não contém form_response' });
    }
    const formId = formResponse.form_id;
    let nome = null;
    let cpf = null;
    let score = null;

    // IDs dos campos para cada formulário
    let nomeFieldId, cpfFieldId;
    if (formId === 'OrKerl6D') { // Português e matemática
      nomeFieldId = 'syzxhm3Z3iGG';
      cpfFieldId = 'dcpqtJoWbXds';
    } else if (formId === 'Z59Mv1sY') { // Direção
      nomeFieldId = 'cPBR2RtoMRBN';
      cpfFieldId = 'ZwvjaHmu1l0b';
    } else if (formId === 'qWTxbaIK') { // Português p/ ADM
      nomeFieldId = 'wR9LPPhM4Fw5';
      cpfFieldId = 'csRM2ZPjJAuZ';
    } else {
      return res.status(400).json({ error: 'Formulário não reconhecido: ' + formId });
    }

    // Extrair nome e CPF pelos IDs dos campos
    if (Array.isArray(formResponse.answers)) {
      const nomeField = formResponse.answers.find(a => a.field?.id === nomeFieldId);
      if (nomeField) nome = nomeField.text || nomeField.value;
      const cpfField = formResponse.answers.find(a => a.field?.id === cpfFieldId);
      if (cpfField) cpf = cpfField.text || cpfField.value;
    }
    // Extrair score do campo variables (quiz_score)
    if (Array.isArray(formResponse.variables)) {
      const scoreVar = formResponse.variables.find(v => v.key === 'quiz_score');
      if (scoreVar) score = scoreVar.number;
    }

    if (!nome && !cpf) {
      console.error('Não foi possível extrair nome nem CPF do payload.');
      return res.status(400).json({ error: 'Nome ou CPF não encontrados no payload.' });
    }
    if (score === null || score === undefined) {
      console.error('Não foi possível extrair score do payload.');
      return res.status(400).json({ error: 'Score não encontrado no payload.' });
    }

    console.log('Nome extraído:', nome);
    console.log('CPF extraído:', cpf);
    console.log('Score extraído:', score);

    // Busca todos os candidatos com o CPF igual (jsonb)
    let candidato = null;
    let buscaPor = '';
    let updateStatus = false;
    let candidatosCpf = [];
    if (cpf) {
      const cpfNormalizado = normalizeCpf(cpf);
      const { data: candidatos, error } = await supabase
        .from('candidaturas')
        .select('id, nome, score_prova, status, dados_estruturados, scores_provas');
      if (error) {
        console.error('Erro ao buscar candidatos:', error.message);
        return res.status(500).json({ error: 'Erro ao buscar candidatos.' });
      }
      candidatosCpf = (candidatos || []).filter(c => {
        const cpfBanco = c.dados_estruturados?.pessoal?.cpf || '';
        return normalizeCpf(cpfBanco) === cpfNormalizado;
      });
      if (candidatosCpf.length === 1) {
        candidato = candidatosCpf[0];
        buscaPor = 'cpf (jsonb) único';
        updateStatus = true;
      } else if (candidatosCpf.length > 1) {
        // Tenta achar o nome mais parecido
        candidato = candidatosCpf.find(c => nomesParecidos(c.nome, nome));
        if (candidato) {
          buscaPor = 'cpf (jsonb) + nome parecido';
          updateStatus = true;
        } else {
          // Se não achou nome parecido, pega o primeiro (mas loga)
          candidato = candidatosCpf[0];
          buscaPor = 'cpf (jsonb) múltiplos, pegou primeiro';
          updateStatus = true;
          console.warn('Mais de um candidato com o mesmo CPF, nenhum nome parecido. Atualizando o primeiro.');
        }
      }
    }
    // Se não achou por CPF, tenta por nome (parecido)
    if (!candidato && nome) {
      const { data: candidatosNome, error: errorNome } = await supabase
        .from('candidaturas')
        .select('id, nome, score_prova, status, dados_estruturados, scores_provas');
      if (errorNome) {
        console.error('Erro ao buscar candidatos por nome:', errorNome.message);
        return res.status(500).json({ error: 'Erro ao buscar candidatos por nome.' });
      }
      candidato = (candidatosNome || []).find(c => nomesParecidos(c.nome, nome));
      if (candidato) {
        buscaPor = 'nome parecido';
        updateStatus = String(candidato.status).toLowerCase() === 'em progresso';
      }
    }

    if (!candidato) {
      console.error('Candidato não encontrado por nome nem CPF.');
      return res.status(404).json({ error: 'Candidato não encontrado por nome nem CPF.' });
    }

    console.log(`Candidato encontrado por ${buscaPor}: ${candidato.nome} (id: ${candidato.id})`);

    // Atualiza apenas scores_provas (JSONB), mantém o status atual
    // Chave da prova será o formId
    const provaKey = formId;
    // Busca o objeto atual de scores (ou inicia vazio)
    let scoresProvas = candidato.scores_provas || {};
    // Se vier como string, tenta converter
    if (typeof scoresProvas === 'string') {
      try { scoresProvas = JSON.parse(scoresProvas); } catch { scoresProvas = {}; }
    }
    // Atualiza/adiciona o score da prova atual
    scoresProvas[provaKey] = score;
    const { error: updateError } = await supabase
      .from('candidaturas')
      .update({ scores_provas: scoresProvas })
      .eq('id', candidato.id);

    if (updateError) {
      console.error('Erro ao atualizar score_prova:', updateError.message);
      return res.status(500).json({ error: 'Erro ao atualizar score_prova.' });
    }

    console.log(`Score atualizado com sucesso para o candidato ${candidato.nome} (id: ${candidato.id})!`);
    return res.json({ success: true, candidato: candidato.nome, id: candidato.id, score });
  } catch (err) {
    console.error('Erro inesperado:', err.message);
    return res.status(500).json({ error: 'Erro inesperado.' });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Servidor webhook-score-prova rodando em http://localhost:${PORT}`);
}); 