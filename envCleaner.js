// envCleaner.js - Clean and validate environment variables
import dotenv from 'dotenv';

/**
 * Limpia variables de entorno eliminando comillas, espacios y validando formatos
 */
export class EnvCleaner {
  constructor() {
    this.cleaned = {};
    this.errors = [];
  }

  /**
   * Limpia una variable string
   */
  cleanString(value) {
    if (!value) return '';
    
    let cleaned = value.toString().trim();
    
    // Eliminar comillas dobles o simples al inicio/final
    if ((cleaned.startsWith('"') && cleaned.endsWith('"')) ||
        (cleaned.startsWith("'") && cleaned.endsWith("'"))) {
      cleaned = cleaned.slice(1, -1);
    }
    
    // Eliminar espacios internos innecesarios (pero no todos)
    cleaned = cleaned.replace(/\s+/g, ' ').trim();
    
    return cleaned;
  }

  /**
   * Limpia una private key (formato Base58)
   */
  cleanPrivateKey(value) {
    if (!value) return '';
    
    let cleaned = this.cleanString(value);
    
    // Eliminar TODOS los espacios (las keys no tienen espacios)
    cleaned = cleaned.replace(/\s/g, '');
    
    // Eliminar caracteres no Base58
    cleaned = cleaned.replace(/[^123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]/g, '');
    
    return cleaned;
  }

  /**
   * Limpia una URL
   */
  cleanURL(value) {
    if (!value) return '';
    
    let cleaned = this.cleanString(value);
    
    // Eliminar espacios en URLs
    cleaned = cleaned.replace(/\s/g, '');
    
    return cleaned;
  }

  /**
   * Limpia un número
   */
  cleanNumber(value) {
    if (!value) return '';
    
    let cleaned = this.cleanString(value);
    
    // Solo mantener dígitos, puntos y signos
    cleaned = cleaned.replace(/[^\d.-]/g, '');
    
    return cleaned;
  }

  /**
   * Limpia un booleano
   */
  cleanBoolean(value) {
    if (!value) return 'false';
    
    const cleaned = this.cleanString(value).toLowerCase();
    
    if (cleaned === 'true' || cleaned === '1' || cleaned === 'yes') {
      return 'true';
    }
    
    return 'false';
  }

  /**
   * Valida que una private key sea Base58 válida
   */
  validatePrivateKey(key) {
    if (!key) {
      return { valid: false, error: 'Private key is empty' };
    }

    // Debe tener exactamente 88 caracteres (Base58 de 64 bytes)
    if (key.length !== 88) {
      return { 
        valid: false, 
        error: `Invalid length: ${key.length} chars (expected 88)` 
      };
    }

    // Debe contener solo caracteres Base58
    const base58Regex = /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+$/;
    if (!base58Regex.test(key)) {
      return { 
        valid: false, 
        error: 'Contains invalid Base58 characters' 
      };
    }

    return { valid: true };
  }

  /**
   * Valida URL de RPC
   */
  validateRPCURL(url) {
    if (!url) {
      return { valid: false, error: 'RPC URL is empty' };
    }

    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      return { 
        valid: false, 
        error: 'RPC URL must start with http:// or https://' 
      };
    }

    return { valid: true };
  }

  /**
   * Limpia todas las variables de entorno críticas
   */
  cleanAllEnv() {
    console.log('🧹 Cleaning environment variables...\n');

    // 1. PRIVATE_KEY (CRÍTICO)
    const rawPrivateKey = process.env.PRIVATE_KEY;
    this.cleaned.PRIVATE_KEY = this.cleanPrivateKey(rawPrivateKey);
    
    const keyValidation = this.validatePrivateKey(this.cleaned.PRIVATE_KEY);
    if (!keyValidation.valid) {
      this.errors.push(`❌ PRIVATE_KEY: ${keyValidation.error}`);
      console.error(`❌ PRIVATE_KEY INVALID: ${keyValidation.error}`);
      console.error(`   Raw length: ${rawPrivateKey?.length || 0}`);
      console.error(`   Cleaned length: ${this.cleaned.PRIVATE_KEY.length}`);
      console.error(`   First 20 chars: ${this.cleaned.PRIVATE_KEY.slice(0, 20)}...`);
    } else {
      console.log(`✅ PRIVATE_KEY: Valid (${this.cleaned.PRIVATE_KEY.length} chars)`);
    }

    // 2. URLs
    this.cleaned.RPC_URL = this.cleanURL(process.env.RPC_URL);
    this.cleaned.REDIS_URL = this.cleanURL(process.env.REDIS_URL);
    this.cleaned.FLINTR_WS_URL = this.cleanURL(process.env.FLINTR_WS_URL);

    const rpcValidation = this.validateRPCURL(this.cleaned.RPC_URL);
    if (!rpcValidation.valid) {
      this.errors.push(`❌ RPC_URL: ${rpcValidation.error}`);
      console.error(`❌ RPC_URL: ${rpcValidation.error}`);
    } else {
      console.log(`✅ RPC_URL: ${this.cleaned.RPC_URL.slice(0, 50)}...`);
    }

    // 3. Program IDs
    this.cleaned.PUMP_PROGRAM_ID = this.cleanString(process.env.PUMP_PROGRAM_ID);
    console.log(`✅ PUMP_PROGRAM_ID: ${this.cleaned.PUMP_PROGRAM_ID}`);

    // 4. Tokens y API Keys
    this.cleaned.TELEGRAM_BOT_TOKEN = this.cleanString(process.env.TELEGRAM_BOT_TOKEN);
    this.cleaned.FLINTR_API_KEY = this.cleanString(process.env.FLINTR_API_KEY);

    // 5. Números (trading config)
    this.cleaned.POSITION_SIZE_SOL = this.cleanNumber(process.env.POSITION_SIZE_SOL || '0.1');
    this.cleaned.MAX_POSITIONS = this.cleanNumber(process.env.MAX_POSITIONS || '2');
    this.cleaned.PRIORITY_FEE_MICROLAMPORTS = this.cleanNumber(process.env.PRIORITY_FEE_MICROLAMPORTS || '300000');
    this.cleaned.COPY_PROFIT_TARGET = this.cleanNumber(process.env.COPY_PROFIT_TARGET || '200');
    this.cleaned.COPY_STOP_LOSS = this.cleanNumber(process.env.COPY_STOP_LOSS || '15');
    this.cleaned.TRAILING_STOP = this.cleanNumber(process.env.TRAILING_STOP || '15');
    this.cleaned.MIN_WALLETS_TO_BUY = this.cleanNumber(process.env.MIN_WALLETS_TO_BUY || '1');
    this.cleaned.MIN_WALLETS_TO_SELL = this.cleanNumber(process.env.MIN_WALLETS_TO_SELL || '1');

    console.log(`✅ POSITION_SIZE_SOL: ${this.cleaned.POSITION_SIZE_SOL}`);
    console.log(`✅ PRIORITY_FEE: ${this.cleaned.PRIORITY_FEE_MICROLAMPORTS} microlamports`);

    // 6. Booleanos
    this.cleaned.DRY_RUN = this.cleanBoolean(process.env.DRY_RUN);
    this.cleaned.ENABLE_AUTO_TRADING = this.cleanBoolean(process.env.ENABLE_AUTO_TRADING);
    this.cleaned.COPY_PROFIT_TARGET_ENABLED = this.cleanBoolean(process.env.COPY_PROFIT_TARGET_ENABLED);
    this.cleaned.COPY_STOP_LOSS_ENABLED = this.cleanBoolean(process.env.COPY_STOP_LOSS_ENABLED);
    this.cleaned.TRAILING_STOP_ENABLED = this.cleanBoolean(process.env.TRAILING_STOP_ENABLED);
    this.cleaned.BLOCK_REBUYS = this.cleanBoolean(process.env.BLOCK_REBUYS);
    this.cleaned.TELEGRAM_LIVE_UPDATES = this.cleanBoolean(process.env.TELEGRAM_LIVE_UPDATES);

    console.log(`✅ DRY_RUN: ${this.cleaned.DRY_RUN}`);
    console.log(`✅ ENABLE_AUTO_TRADING: ${this.cleaned.ENABLE_AUTO_TRADING}`);

    // 7. Chat IDs
    this.cleaned.TELEGRAM_OWNER_CHAT_ID = this.cleanString(process.env.TELEGRAM_OWNER_CHAT_ID);

    console.log('\n✅ Environment cleaning completed');
    
    if (this.errors.length > 0) {
      console.error('\n⚠️  ERRORS FOUND:');
      this.errors.forEach(err => console.error(`   ${err}`));
      return false;
    }

    return true;
  }

  /**
   * Aplica las variables limpiadas a process.env
   */
  applyCleanedEnv() {
    for (const [key, value] of Object.entries(this.cleaned)) {
      process.env[key] = value;
    }
    
    console.log('✅ Cleaned variables applied to process.env\n');
  }

  /**
   * Genera un .env limpio para debugging
   */
  generateCleanEnvFile() {
    let content = '# Cleaned Environment Variables\n\n';
    
    for (const [key, value] of Object.entries(this.cleaned)) {
      // Ocultar valores sensibles
      let displayValue = value;
      if (key === 'PRIVATE_KEY') {
        displayValue = value.slice(0, 20) + '...' + value.slice(-20);
      } else if (key.includes('TOKEN') || key.includes('KEY') || key.includes('URL')) {
        if (value.length > 50) {
          displayValue = value.slice(0, 30) + '...' + value.slice(-20);
        }
      }
      
      content += `${key}="${displayValue}"\n`;
    }
    
    return content;
  }
}

/**
 * Función principal para limpiar env al inicio de la app
 */
export function cleanAndValidateEnv() {
  const cleaner = new EnvCleaner();
  const success = cleaner.cleanAllEnv();
  
  if (!success) {
    console.error('\n❌ Environment validation failed!');
    console.error('   Fix the errors above before starting the bot.\n');
    process.exit(1);
  }
  
  cleaner.applyCleanedEnv();
  
  return cleaner;
}

/**
 * Helper: Get cleaned env value
 */
export function getCleanEnv(key, defaultValue = '') {
  const cleaner = new EnvCleaner();
  
  const value = process.env[key] || defaultValue;
  
  if (key === 'PRIVATE_KEY') {
    return cleaner.cleanPrivateKey(value);
  } else if (key.includes('URL')) {
    return cleaner.cleanURL(value);
  } else if (value === 'true' || value === 'false') {
    return cleaner.cleanBoolean(value);
  } else if (!isNaN(value)) {
    return cleaner.cleanNumber(value);
  }
  
  return cleaner.cleanString(value);
}
