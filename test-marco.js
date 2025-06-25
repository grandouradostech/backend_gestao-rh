const { extrairDataNascimento, calcularIdade } = require('./importar-candidaturas');

console.log('🧪 Teste específico para "25 março 1983"...\n');

const teste = '25 março 1983';
console.log(`Teste: "${teste}"`);

const dataExtraida = extrairDataNascimento(teste);
const idade = dataExtraida ? calcularIdade(dataExtraida) : null;

if (dataExtraida) {
  console.log(`   ✅ Data extraída: ${dataExtraida} (Idade: ${idade} anos)`);
} else {
  console.log(`   ❌ Não foi possível extrair data válida`);
}

console.log('\n🔍 Testando outros formatos similares...\n');

const outrosTestes = [
  '25 março 1983',
  '25 marco 1983',
  '25 de março de 1983',
  '25 de marco de 1983',
  '25 mar 1983'
];

outrosTestes.forEach((teste, index) => {
  console.log(`Teste ${index + 1}: "${teste}"`);
  
  const dataExtraida = extrairDataNascimento(teste);
  const idade = dataExtraida ? calcularIdade(dataExtraida) : null;
  
  if (dataExtraida) {
    console.log(`   ✅ Data extraída: ${dataExtraida} (Idade: ${idade} anos)`);
  } else {
    console.log(`   ❌ Não foi possível extrair data válida`);
  }
  console.log('');
}); 