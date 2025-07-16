# Deploy no Render

## Configuração para Render

### 1. Variáveis de Ambiente Necessárias

Configure as seguintes variáveis no Render:

- `SUPABASE_URL`: URL do seu projeto Supabase
- `SUPABASE_SERVICE_ROLE_KEY`: Service Role Key do Supabase
- `OPENAI_KEY`: Chave da API OpenAI
- `TYPEFORM_TOKEN`: Token do Typeform
- `JWT_SECRET`: Chave secreta para JWT (pode ser qualquer string)

### 2. URL do Webhook de Provas

Após o deploy, o endpoint estará disponível em:

```
https://backend-gestao-rh-mdmw.onrender.com/webhook-score-prova
```

### 3. Configuração no Typeform

No Typeform, configure o webhook para apontar para:
```
https://backend-gestao-rh-mdmw.onrender.com/webhook-score-prova
```

### 4. Endpoints Disponíveis

- `POST /webhook-score-prova` - Webhook para receber scores das provas
- `POST /typeform-webhook` - Webhook principal para candidaturas
- `GET /` - Health check

### 5. Logs

Os logs podem ser visualizados no dashboard do Render em tempo real.

### 6. Troubleshooting

Se houver problemas:
1. Verifique se todas as variáveis de ambiente estão configuradas
2. Verifique os logs no Render
3. Teste o endpoint com um POST request simples 