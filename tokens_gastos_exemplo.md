# Estrutura da Coluna `tokens_gastos`

A coluna `tokens_gastos` na tabela `candidaturas` agora armazena informações detalhadas sobre o consumo de tokens da OpenAI durante o processamento de cada candidatura.

## Estrutura JSON

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

## Campos Explicados

### `analise`
- **prompt_tokens**: Tokens usados no prompt da análise da candidatura
- **completion_tokens**: Tokens usados na resposta da análise
- **total_tokens**: Total de tokens da análise (prompt + completion)
- **model**: Modelo usado (sempre "gpt-4o")
- **timestamp**: Momento em que a análise foi executada

### `estruturacao`
- **prompt_tokens**: Tokens usados no prompt da estruturação dos dados
- **completion_tokens**: Tokens usados na resposta da estruturação
- **total_tokens**: Total de tokens da estruturação
- **model**: Modelo usado (sempre "gpt-4o")
- **timestamp**: Momento em que a estruturação foi executada

### `total_tokens`
- Soma total de todos os tokens gastos (análise + estruturação)

### `timestamp`
- Momento em que o registro foi salvo no banco

## Exemplo de Uso

```sql
-- Buscar candidaturas com maior consumo de tokens
SELECT 
  nome,
  tokens_gastos->>'total_tokens' as total_tokens,
  tokens_gastos->'analise'->>'total_tokens' as tokens_analise,
  tokens_gastos->'estruturacao'->>'total_tokens' as tokens_estruturacao
FROM candidaturas 
WHERE tokens_gastos IS NOT NULL
ORDER BY (tokens_gastos->>'total_tokens')::int DESC;

-- Calcular custo total (assumindo $0.01 por 1K tokens)
SELECT 
  SUM((tokens_gastos->>'total_tokens')::int) as total_tokens,
  SUM((tokens_gastos->>'total_tokens')::int) * 0.01 / 1000 as custo_estimado_usd
FROM candidaturas 
WHERE tokens_gastos IS NOT NULL;
```

## Logs no Console

Durante o processamento, você verá logs como:
```
[WEBHOOK] Tokens gastos - Análise: 2798, Estruturação: 245, Total: 3043
```

Isso permite monitorar o consumo de tokens em tempo real. 