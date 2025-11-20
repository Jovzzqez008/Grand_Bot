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
    if (value == null) return '';
    return String(value).trim().replace(/^['"]+|['"]+$/g, '');
  }

  /**
   * Limpia un booleano
   */
  cleanBoolean(value) {
    if (value == null) return false;
    const v = String(value).trim().toLowerCase();
    return ['1', 'true', 'yes', 'y', 'on', 'paper'].includes(v);
  }

  /**
   * Limpia un número
   */
  cleanNumber(value, defaultValue = 0) {
    if (value == null || value === '') return defaultValue;
    const num = Number(String(value).trim());
    return Number.isFinite(num) ? num : defaultValue;
  }

  /**
   * Limpia una URL
   */
  cleanURL(value) {
    if (!value) return '';
    let cleaned = this.cleanString(value);
    if (!cleaned) return '';

    try {
      const url = new URL(cleaned);
      return url.toString();
    } catch {
      console.warn(`⚠️ Invalid URL format: ${cleaned}`);
      return cleaned;
    }
  }

  /**
   * Limpia PRIVATE_KEY (quita espacios, saltos de línea y comillas)
   */
  cleanPrivateKey(value) {
    if (!value) return '';
    let cleaned = String(value)
      .replace(/\s+/g, '')
      .replace(/^['"]+|['"]+$/g, '');
    return cleaned;
  }

  /**
   * Valida PRIVATE_KEY
   */
  validatePrivateKey(value) {
    if (!value) {
      return { valid: false, error: 'Missing PRIVATE_KEY' };
    }

    if (value.length < 64) {
      return {
        valid: false,
        error: `Too short. Expected ~88 chars (base58), got ${value.length}`,
      };
    }

    if (value.length > 120) {
      return {
        valid: false,
        error: `Too long. Expected ~88 chars (base58), got ${value.length}`,
      };
    }

    return { valid: true };
  }

  /**
   * Valida un RPC_URL básico
   */
  validateRPCURL(value) {
    if (!value) {
      return { valid: false, error: 'Missing RPC_URL' };
    }

    if (!value.startsWith('http://') && !value.startsWith('https://')) {
      return {
        valid: false,
        error: 'RPC_URL must start with http:// or https://',
      };
    }

    if (!value.includes('solana') && !value.includes('quicknode')) {
      console.warn(
        `⚠️ RPC_URL does not look like Solana RPC: ${value.slice(0, 50)}...`,
      );
    }

    return { valid: true };
  }

  /**
   * Limpia TODAS las variables críticas
   */
  cleanAllEnv() {
    dotenv.config();

    // 1. PRIVATE_KEY
    const rawPrivateKey = process.env.PRIVATE_KEY;
    this.cleaned.PRIVATE_KEY = this.cleanPrivateKey(rawPrivateKey);

    const keyValidation = this.validatePrivateKey(this.cleaned.PRIVATE_KEY);
    if (!keyValidation.valid) {
      this.errors.push(`❌ PRIVATE_KEY: ${keyValidation.error}`);
      console.error(`❌ PRIVATE_KEY INVALID: ${keyValidation.error}`);
      console.error(`   Raw length: ${rawPrivateKey?.length || 0}`);
      console.error(
        `   Cleaned length: ${this.cleaned.PRIVATE_KEY.length}`,
      );
      console.error(
        `   First 20 chars: ${this.cleaned.PRIVATE_KEY.slice(0, 20)}...`,
      );
    } else {
      console.log(
        `✅ PRIVATE_KEY: Valid (${this.cleaned.PRIVATE_KEY.length} chars)`,
      );
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
    this.cleaned.PUMP_PROGRAM_ID = this.cleanString(
      process.env.PUMP_PROGRAM_ID,
    );
    console.log(`✅ PUMP_PROGRAM_ID: ${this.cleaned.PUMP_PROGRAM_ID}`);

    // 4. Telegram
    this.cleaned.TELEGRAM_BOT_TOKEN = this.cleanString(
      process.env.TELEGRAM_BOT_TOKEN,
    );
    this.cleaned.TELEGRAM_CHAT_ID = this.cleanString(
      process.env.TELEGRAM_CHAT_ID,
    );
    this.cleaned.TELEGRAM_OWNER_CHAT_ID = this.cleanString(
      process.env.TELEGRAM_OWNER_CHAT_ID || process.env.TELEGRAM_CHAT_ID,
    );

    // 5. Trading y riesgo
    this.cleaned.DRY_RUN = this.cleanBoolean(process.env.DRY_RUN);
    this.cleaned.ENABLE_AUTO_TRADING = this.cleanBoolean(
      process.env.ENABLE_AUTO_TRADING,
    );

    this.cleaned.POSITION_SIZE_SOL = this.cleanNumber(
      process.env.POSITION_SIZE_SOL,
      0.01,
    );
    this.cleaned.MAX_POSITIONS = this.cleanNumber(
      process.env.MAX_POSITIONS,
      2,
    );
    this.cleaned.RESERVED_FLINTR_POSITIONS = this.cleanNumber(
      process.env.RESERVED_FLINTR_POSITIONS,
      1,
    );

    this.cleaned.MIN_LIQUIDITY_SOL = this.cleanNumber(
      process.env.MIN_LIQUIDITY_SOL,
      2,
    );
    this.cleaned.MIN_INITIAL_VOLUME_SOL = this.cleanNumber(
      process.env.MIN_INITIAL_VOLUME_SOL,
      0.2,
    );
    this.cleaned.MAX_DAILY_LOSS_SOL = this.cleanNumber(
      process.env.MAX_DAILY_LOSS_SOL,
      1,
    );

    this.cleaned.STOP_LOSS_PERCENT = this.cleanNumber(
      process.env.STOP_LOSS_PERCENT,
      13,
    );
    this.cleaned.TAKE_PROFIT_PERCENT = this.cleanNumber(
      process.env.TAKE_PROFIT_PERCENT,
      30,
    );
    this.cleaned.TRAILING_STOP_PERCENT = this.cleanNumber(
      process.env.TRAILING_STOP_PERCENT,
      15,
    );

    // 6. Slippage / fees
    this.cleaned.SLIPPAGE_BUY_PERCENT = this.cleanNumber(
      process.env.SLIPPAGE_BUY_PERCENT,
      10,
    );
    this.cleaned.SLIPPAGE_SELL_PERCENT = this.cleanNumber(
      process.env.SLIPPAGE_SELL_PERCENT,
      10,
    );
    this.cleaned.PUMP_SLIPPAGE_PERCENT_BUY = this.cleanNumber(
      process.env.PUMP_SLIPPAGE_PERCENT_BUY,
      10,
    );
    this.cleaned.PUMP_SLIPPAGE_PERCENT_SELL = this.cleanNumber(
      process.env.PUMP_SLIPPAGE_PERCENT_SELL,
      10,
    );

    this.cleaned.PRIORITY_FEE = this.cleanNumber(
      process.env.PRIORITY_FEE,
      0.00005,
    );
    this.cleaned.COMPUTE_UNIT_LIMIT = this.cleanNumber(
      process.env.COMPUTE_UNIT_LIMIT,
      800000,
    );
    this.cleaned.COMPUTE_UNIT_PRICE_MICROLAMPORTS = this.cleanNumber(
      process.env.COMPUTE_UNIT_PRICE_MICROLAMPORTS,
      5000,
    );

    // 7. Logging, intervalos
    this.cleaned.RISK_TICK_INTERVAL = this.cleanNumber(
      process.env.RISK_TICK_INTERVAL,
      5000,
    );
    this.cleaned.VERBOSE_LOGGING = this.cleanBoolean(
      process.env.VERBOSE_LOGGING,
    );

    if (this.errors.length > 0) {
      console.error('\n❌ Environment errors:');
      for (const err of this.errors) {
        console.error('   ' + err);
      }
      return false;
    }

    console.log('✅ Environment variables cleaned and validated.');
    return true;
  }

  /**
   * Aplica las variables limpias a process.env
   */
  applyCleanedEnv() {
    for (const [key, value] of Object.entries(this.cleaned)) {
      process.env[key] = String(value);
    }
  }

  /**
   * Devuelve un resumen de variables limpias (para debug)
   */
  getSummary() {
    const summary = { ...this.cleaned };
    if (summary.PRIVATE_KEY) {
      summary.PRIVATE_KEY = `***${summary.PRIVATE_KEY.slice(-6)}`;
    }
    return summary;
  }

  /**
   * Devuelve contenido .env "limpio" (por si lo quieres imprimir/guardar)
   */
  toEnvFileContent() {
    let content = '';
    for (const [key, value] of Object.entries(this.cleaned)) {
      let displayValue = value;
      if (key === 'PRIVATE_KEY') {
        displayValue = `***${String(value).slice(-6)}`;
      } else if (typeof value === 'boolean') {
        displayValue = value ? 'true' : 'false';
      } else if (typeof value === 'number') {
        displayValue = String(value);
      } else {
        displayValue = String(value);
        if (displayValue.length > 60) {
          displayValue =
            value.slice(0, 30) + '...' + value.slice(-20);
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
 * Helper para leer una variable limpia, con fallback
 */
export function getCleanEnv(key, defaultValue = '') {
  const cleaner = new EnvCleaner();
  cleaner.cleanAllEnv();
  cleaner.applyCleanedEnv();

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
