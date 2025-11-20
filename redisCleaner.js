// redisCleaner.js - Limpiador inteligente para Redis
// 🧹 Elimina:
// 1. Cache de precios viejos (price:*)
// 2. Posiciones 'fantasmas' (en open_positions pero sin datos)
// 3. Posiciones cerradas antiguas (position:*)
// 4. Historial de trades muy antiguo (trades:YYYY-MM-DD)
// 5. Señales acumuladas (sniper_signals)

import 'dotenv/config';
import IORedis from 'ioredis';

// CONFIGURACIÓN
const RETENTION_DAYS = 3; // Días de historial a mantener
const EXECUTE_MODE = process.env.EXECUTE === 'true'; // true = BORRAR, false = SOLO REPORTAR

console.log('🧹 Redis Cleaner Initialized');
console.log(`   Mode: ${EXECUTE_MODE ? '🔥 EXECUTE (Deleting data)' : '👀 DRY RUN (Reporting only)'}`);
console.log(`   History Retention: ${RETENTION_DAYS} days`);

if (!process.env.REDIS_URL) {
  console.error('❌ Error: REDIS_URL not set in .env');
  process.exit(1);
}

const redis = new IORedis(process.env.REDIS_URL);

async function cleanGhostPositions() {
  console.log('\n👻 Checking for Ghost Positions...');
  const openMints = await redis.smembers('open_positions');
  let ghostsFound = 0;

  for (const mint of openMints) {
    const exists = await redis.exists(`position:${mint}`);
    if (!exists) {
      console.log(`   Found ghost in open_positions: ${mint.slice(0, 8)}...`);
      ghostsFound++;
      if (EXECUTE_MODE) {
        await redis.srem('open_positions', mint);
      }
    }
  }
  console.log(`   Result: ${ghostsFound} ghosts ${EXECUTE_MODE ? 'removed' : 'found'}.`);
}

async function cleanStalePositions() {
  console.log('\n📦 Checking for Old Closed Positions...');
  // Escanear todas las keys que empiecen por position:
  const keys = await scanKeys('position:*');
  let closedFound = 0;
  let deleted = 0;

  for (const key of keys) {
    const position = await redis.hgetall(key);
    
    // Criterio: Si está cerrada O si no tiene estado (data corrupta)
    if (position.status === 'closed' || !position.status) {
      // Verificar antigüedad (opcional, aquí borramos todo lo cerrado para ahorrar espacio)
      console.log(`   Found closed/stale position: ${key}`);
      closedFound++;
      
      if (EXECUTE_MODE) {
        await redis.del(key);
        deleted++;
      }
    }
  }
  console.log(`   Result: ${closedFound} closed positions found, ${deleted} deleted.`);
}

async function cleanPriceCache() {
  console.log('\n💰 Cleaning Price Cache...');
  const keys = await scanKeys('price:*');
  console.log(`   Found ${keys.length} price cache keys.`);

  if (EXECUTE_MODE && keys.length > 0) {
    // Borrar en lotes para no saturar
    const batchSize = 100;
    for (let i = 0; i < keys.length; i += batchSize) {
      const batch = keys.slice(i, i + batchSize);
      await redis.del(...batch);
    }
    console.log('   ✅ All price cache cleared.');
  } else if (keys.length > 0) {
    console.log('   Skipping deletion (Dry Run).');
  }
}

async function cleanOldHistory() {
  console.log('\n📜 Checking Old Trade History...');
  const keys = await scanKeys('trades:*');
  const today = new Date();
  let oldFound = 0;

  for (const key of keys) {
    // Formato trades:YYYY-MM-DD
    const datePart = key.split(':')[1];
    if (!datePart) continue;

    const fileDate = new Date(datePart);
    const diffTime = Math.abs(today - fileDate);
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)); 

    if (diffDays > RETENTION_DAYS) {
      console.log(`   Found old history: ${key} (${diffDays} days old)`);
      oldFound++;
      if (EXECUTE_MODE) {
        await redis.del(key);
      }
    }
  }
  console.log(`   Result: ${oldFound} old history lists ${EXECUTE_MODE ? 'deleted' : 'found'}.`);
}

async function cleanSignals() {
  console.log('\n📡 Cleaning Signal Queue...');
  const len = await redis.llen('sniper_signals');
  
  if (len > 1000) {
    console.log(`   Queue too large (${len}), trimming to last 1000...`);
    if (EXECUTE_MODE) {
      await redis.ltrim('sniper_signals', 0, 999); // Mantener solo los ultimos 1000
      console.log('   ✅ Trimmed.');
    }
  } else {
    console.log(`   Queue size OK (${len})`);
  }
}

// Helper para escanear keys sin bloquear Redis
async function scanKeys(pattern) {
  let cursor = '0';
  let keys = [];
  do {
    const result = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    cursor = result[0];
    keys.push(...result[1]);
  } while (cursor !== '0');
  return keys;
}

async function run() {
  try {
    await cleanGhostPositions();
    await cleanStalePositions();
    await cleanOldHistory();
    await cleanPriceCache();
    await cleanSignals();

    console.log('\n✨ Cleaning finished.');
  } catch (error) {
    console.error('Error during cleaning:', error);
  } finally {
    redis.disconnect();
  }
}

run();
