const supabase = require('./supabaseClient');

// Adiciona rotas relacionadas a usuários RH
function setupUsuariosRoutes(app, auth) {
  // Listar todos os usuários do RH (para seleção de responsável)
  app.get('/usuarios', auth, async (req, res) => {
    try {
      const { data, error } = await supabase
        .from('usuarios_rh')
        .select('id, nome, email, role, imagem_url')
        .order('nome', { ascending: true });
      if (error) return res.status(500).json({ error: error.message });
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: 'Erro ao listar usuários' });
    }
  });
}

module.exports = setupUsuariosRoutes; 