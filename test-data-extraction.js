const { extrairDataNascimento, calcularIdade } = require('./importar-candidaturas');

// Testes com os formatos mencionados
const testes = [
  '10/08/2000',
  '16.06.2006',
  '22011987',
  '30-10-1985',
  '6 de julho de 1978',
  '30 12 1979',
  '3/8/1982',
  '15 de janeiro de 1990',
  '25 março 1983',
  '1995-12-25',
  '31/02/2020', // Data inválida (fevereiro não tem dia 31)
  '32/13/2020', // Data inválida (mês 13)
  'abc123', // Texto inválido
  '', // String vazia
  null, // Null
  undefined // Undefined
];

console.log('🧪 Testando extração de datas de nascimento...\n');

testes.forEach((teste, index) => {
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

// Teste adicional com diferentes formatos
console.log('🔍 Testes adicionais com formatos variados...\n');

const testesAdicionais = [
  '1 de janeiro de 2000',
  '15 fev 1995',
  '20 de março de 1988',
  '10 abril 1992',
  '5 de maio de 1985',
  '12 jun 1998',
  '25 de julho de 1991',
  '8 ago 1987',
  '30 de setembro de 1993',
  '15 out 1989',
  '22 de novembro de 1996',
  '3 dez 1984'
];

testesAdicionais.forEach((teste, index) => {
  console.log(`Teste adicional ${index + 1}: "${teste}"`);
  
  const dataExtraida = extrairDataNascimento(teste);
  const idade = dataExtraida ? calcularIdade(dataExtraida) : null;
  
  if (dataExtraida) {
    console.log(`   ✅ Data extraída: ${dataExtraida} (Idade: ${idade} anos)`);
  } else {
    console.log(`   ❌ Não foi possível extrair data válida`);
  }
  console.log('');
}); 