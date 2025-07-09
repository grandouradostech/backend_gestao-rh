# Resumo das Alterações - Captura de Tokens Gastos

## 🎯 Objetivo
Implementar a captura e armazenamento das informações de tokens gastos pela OpenAI durante o processamento de candidaturas na coluna `tokens_gastos` da tabela `candidaturas`.

## 📝 Alterações Realizadas

### 1. **services/openai-analise.js**
- ✅ Modificada função `analisarCandidatura()` para capturar informações de tokens da resposta da OpenAI
- ✅ Modificada função `estruturarDados()` para capturar informações de tokens da estruturação
- ✅ Ambas as funções agora retornam objetos com informações detalhadas de tokens

### 2. **index.js**
- ✅ Webhook `/typeform-webhook` atualizado para salvar `tokens_gastos` no banco
- ✅ Endpoint de reanálise `/candidaturas/:response_id/reanalisar-ia` atualizado
- ✅ Adicionado endpoint `/candidaturas/tokens-estatisticas` para consultar estatísticas
- ✅ Logs adicionados para mostrar consumo de tokens em tempo real

### 3. **importar-candidaturas.js**
- ✅ Script de importação atualizado para salvar `tokens_gastos`
- ✅ Logs adicionados para mostrar consumo durante importação

### 4. **Documentação**
- ✅ Criado `tokens_gastos_exemplo.md` com estrutura e exemplos de uso
- ✅ Criado `RESUMO_ALTERACOES_TOKENS.md` (este arquivo)

## 🗂️ Estrutura dos Dados Salvos

A coluna `tokens_gastos` armazena um JSONB com a seguinte estrutura:

```json
{
  "analise": {
    "prompt_tokens": 2456,
    "completion_tokens": 342,
    "total_tokens": 2798,
    "model": "gpt-4o",
    "timestamp": "2024-01-15T10:30:45.123Z"
  },
  "estruturacao": {
    "prompt_tokens": 156,
    "completion_tokens": 89,
    "total_tokens": 245,
    "model": "gpt-4o",
    "timestamp": "2024-01-15T10:28:12.456Z"
  },
  "total_tokens": 3043,
  "timestamp": "2024-01-15T10:30:45.789Z"
}
```

## 🔍 Novos Endpoints

### GET `/candidaturas/tokens-estatisticas`
- **Acesso**: Apenas gestores (autenticação + role gestor)
- **Retorna**: Estatísticas completas de consumo de tokens
- **Inclui**: Total de tokens, média por candidatura, candidaturas mais caras, custo estimado

## 📊 Logs Adicionados

Durante o processamento, você verá logs como:
```
[WEBHOOK] Tokens gastos - Análise: 2798, Estruturação: 245, Total: 3043
[REANALISE] Tokens gastos - Análise: 2798, Total: 2798
💰 Tokens gastos - Análise: 2798, Estruturação: 245, Total: 3043
```

## 💰 Cálculo de Custos

O sistema calcula automaticamente o custo estimado baseado em:
- **Taxa**: $0.01 por 1.000 tokens (configurável)
- **Fórmula**: `(total_tokens * 0.01) / 1000`

## 🚀 Como Testar

1. **Processar uma nova candidatura** via webhook
2. **Verificar logs** no console para ver consumo de tokens
3. **Consultar banco** para ver dados salvos na coluna `tokens_gastos`
4. **Acessar endpoint** `/candidaturas/tokens-estatisticas` para ver estatísticas

## 📋 Exemplo de Consulta SQL

```sql
-- Buscar candidaturas com maior consumo
SELECT 
  nome,
  tokens_gastos->>'total_tokens' as total_tokens,
  tokens_gastos->'analise'->>'total_tokens' as tokens_analise
FROM candidaturas 
WHERE tokens_gastos IS NOT NULL
ORDER BY (tokens_gastos->>'total_tokens')::int DESC;
```

## ✅ Status da Implementação

- ✅ Captura de tokens na análise
- ✅ Captura de tokens na estruturação
- ✅ Salvamento no banco de dados
- ✅ Logs em tempo real
- ✅ Endpoint de estatísticas
- ✅ Documentação completa
- ✅ Compatibilidade com todos os fluxos existentes

A implementação está **100% completa** e pronta para uso em produção! 