// tradeExecutor.js - MEJORADO con trading LIVE para Pump.fun
// ✅ Soporte LIVE via PumpPortal API
// ✅ Retry automático en transacciones
// ✅ Slippage dinámico
// ✅ Priority fees configurables
// ✅ Validaciones pre-trade

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
  LAMPORTS_PER_SOL
} from '@solana/web3.js';
import bs58 from 'bs58';
import { getPriceService } from './priceService.js';

const priceService = getPriceService();

// ═══════════════════════════════════════════════════════
// CONFIGURACIÓN
// ═══════════════════════════════════════════════════════
const PUMPPORTAL_API = 'https://pumpportal.fun/api';
const MAX_TX_RETRIES = 3;
const TX_RETRY_DELAY_MS = 2000;
const TX_CONFIRMATION_TIMEOUT = 60000; // 60s

export class TradeExecutor {
  constructor(privateKey, rpcUrl, dryRun = true) {
    this.dryRun = !!dryRun;
    this.rpcUrl = rpcUrl;
    this.connection = new Connection(rpcUrl, 'confirmed');
    
    // Solo parsear keypair si NO está en DRY_RUN
    if (!this.dryRun && privateKey) {
      try {
        this.wallet = Keypair.fromSecretKey(bs58.decode(privateKey));
        console.log(`💼 Wallet cargada: ${this.wallet.publicKey.toBase58()}`);
      } catch (error) {
        console.error('❌ Error cargando wallet:', error?.message);
        throw new Error('Invalid PRIVATE_KEY format');
      }
    } else {
      this.wallet = null;
    }

    // Configuración de fees
    this.priorityFee = parseFloat(process.env.PRIORITY_FEE || '0.00005');
    this.computeUnitLimit = parseInt(process.env.COMPUTE_UNIT_LIMIT || '800000', 10);
    this.computeUnitPrice = parseInt(process.env.COMPUTE_UNIT_PRICE_MICROLAMPORTS || '5000', 10);

    // Slippage
    this.slippageBuyPct = parseFloat(process.env.PUMP_SLIPPAGE_PERCENT_BUY || '10');
    this.slippageSellPct = parseFloat(process.env.PUMP_SLIPPAGE_PERCENT_SELL || '10');

    console.log(`🔧 TradeExecutor inicializado:`);
    console.log(`   Modo: ${this.dryRun ? 'PAPER' : 'LIVE'}`);
    console.log(`   Priority Fee: ${this.priorityFee} SOL`);
    console.log(`   Slippage: Buy ${this.slippageBuyPct}% / Sell ${this.slippageSellPct}%`);
  }

  // ═══════════════════════════════════════════════════════
  // BUY TOKEN
  // ═══════════════════════════════════════════════════════
  async buyToken(mint, solAmount, dex = 'pump', slippage = null) {
    if (!mint || !solAmount || solAmount <= 0) {
      return { success: false, error: 'invalid_parameters' };
    }

    // ─────────────────────────────────────────────────────
    // MODO PAPER (SIMULADO)
    // ─────────────────────────────────────────────────────
    if (this.dryRun) {
      return await this._buyTokenPaper(mint, solAmount);
    }

    // ─────────────────────────────────────────────────────
    // MODO LIVE (REAL)
    // ─────────────────────────────────────────────────────
    return await this._buyTokenLive(mint, solAmount, slippage);
  }

  /**
   * BUY PAPER - Simulación
   */
  async _buyTokenPaper(mint, solAmount) {
    try {
      console.log(`\n📝 [PAPER] Simulando BUY: ${solAmount} SOL → ${mint.slice(0, 8)}`);

      const priceData = await priceService.getPrice(mint, true);
      
      if (!priceData || !priceData.price || priceData.price <= 0) {
        console.log('   ⚠️ Precio inválido, usando fallback');
        return {
          success: true,
          simulated: true,
          dryRun: true,
          mint,
          solSpent: solAmount,
          tokensReceived: solAmount / 0.00000001,
          entryPrice: 0.00000001,
          signature: `paper_buy_${Date.now()}`,
        };
      }

      const entryPrice = priceData.price;
      const tokensReceived = solAmount / entryPrice;

      console.log(`   ✅ [PAPER] ${tokensReceived.toLocaleString()} tokens @ ${entryPrice.toFixed(12)}`);

      return {
        success: true,
        simulated: true,
        dryRun: true,
        mint,
        solSpent: solAmount,
        tokensReceived,
        entryPrice,
        signature: `paper_buy_${Date.now()}`,
        priceData
      };
    } catch (error) {
      console.error('❌ Error en buyTokenPaper:', error?.message);
      return { success: false, error: error?.message || 'paper_buy_error' };
    }
  }

  /**
   * BUY LIVE - Real via PumpPortal
   */
  async _buyTokenLive(mint, solAmount, slippage = null) {
    if (!this.wallet) {
      console.error('❌ No wallet configurada para LIVE trading');
      return { success: false, error: 'no_wallet' };
    }

    try {
      console.log(`\n💰 [LIVE] Comprando ${solAmount} SOL de ${mint.slice(0, 8)}...`);

      // 1. Validaciones pre-trade
      const preCheck = await this._preTradeValidation(solAmount);
      if (!preCheck.valid) {
        return { success: false, error: preCheck.reason };
      }

      // 2. Obtener precio actual para calcular tokens esperados
      const priceData = await priceService.getPrice(mint, true);
      const expectedTokens = priceData?.price ? solAmount / priceData.price : 0;

      // 3. Calcular slippage
      const finalSlippage = slippage || this.slippageBuyPct;
      const slippageBps = Math.floor(finalSlippage * 100); // Convert % to basis points

      // 4. Construir transacción via PumpPortal
      const txData = await this._buildBuyTransaction(mint, solAmount, slippageBps);
      
      if (!txData || !txData.transaction) {
        return { success: false, error: 'failed_build_transaction' };
      }

      // 5. Ejecutar transacción con retry
      const signature = await this._executeTransactionWithRetry(txData.transaction);

      if (!signature) {
        return { success: false, error: 'transaction_failed' };
      }

      console.log(`   ✅ [LIVE] BUY exitoso: ${signature}`);
      console.log(`   🔍 Ver: https://solscan.io/tx/${signature}`);

      // 6. Obtener tokens recibidos (estimado si no podemos leer el tx)
      const tokensReceived = expectedTokens * 0.98; // Estimado con 2% slippage

      return {
        success: true,
        simulated: false,
        dryRun: false,
        mint,
        solSpent: solAmount,
        tokensReceived,
        entryPrice: priceData?.price || solAmount / tokensReceived,
        signature,
        explorerUrl: `https://solscan.io/tx/${signature}`
      };

    } catch (error) {
      console.error('❌ Error en buyTokenLive:', error?.message);
      return { success: false, error: error?.message || 'live_buy_error' };
    }
  }

  // ═══════════════════════════════════════════════════════
  // SELL TOKEN
  // ═══════════════════════════════════════════════════════
  async sellToken(mint, tokenAmount, dex = 'pump', slippage = null) {
    if (!mint || !tokenAmount || tokenAmount <= 0) {
      return { success: false, error: 'invalid_parameters' };
    }

    // ─────────────────────────────────────────────────────
    // MODO PAPER
    // ─────────────────────────────────────────────────────
    if (this.dryRun) {
      return await this._sellTokenPaper(mint, tokenAmount);
    }

    // ─────────────────────────────────────────────────────
    // MODO LIVE
    // ─────────────────────────────────────────────────────
    return await this._sellTokenLive(mint, tokenAmount, slippage);
  }

  /**
   * SELL PAPER - Simulación
   */
  async _sellTokenPaper(mint, tokenAmount) {
    try {
      console.log(`\n📝 [PAPER] Simulando SELL: ${tokenAmount.toLocaleString()} tokens de ${mint.slice(0, 8)}`);

      const valueData = await priceService.calculateCurrentValue(mint, tokenAmount);

      if (!valueData || !valueData.solValue || valueData.solValue <= 0) {
        console.log('   ⚠️ No se pudo calcular valor, usando fallback');
        return {
          success: true,
          simulated: true,
          dryRun: true,
          mint,
          tokensSold: tokenAmount,
          solReceived: tokenAmount * 0.00000001,
          exitPrice: 0.00000001,
          source: 'fallback',
          signature: `paper_sell_${Date.now()}`,
        };
      }

      console.log(`   ✅ [PAPER] ${valueData.solValue.toFixed(6)} SOL @ ${valueData.marketPrice.toFixed(12)}`);

      return {
        success: true,
        simulated: true,
        dryRun: true,
        mint,
        tokensSold: tokenAmount,
        solReceived: valueData.solValue,
        exitPrice: valueData.marketPrice,
        source: valueData.source,
        signature: `paper_sell_${Date.now()}`,
      };
    } catch (error) {
      console.error('❌ Error en sellTokenPaper:', error?.message);
      return { success: false, error: error?.message || 'paper_sell_error' };
    }
  }

  /**
   * SELL LIVE - Real via PumpPortal
   */
  async _sellTokenLive(mint, tokenAmount, slippage = null) {
    if (!this.wallet) {
      return { success: false, error: 'no_wallet' };
    }

    try {
      console.log(`\n💰 [LIVE] Vendiendo ${tokenAmount.toLocaleString()} tokens de ${mint.slice(0, 8)}...`);

      // 1. Obtener valor esperado
      const valueData = await priceService.calculateCurrentValue(mint, tokenAmount);
      const expectedSol = valueData?.solValue || 0;

      // 2. Slippage
      const finalSlippage = slippage || this.slippageSellPct;
      const slippageBps = Math.floor(finalSlippage * 100);

      // 3. Construir transacción
      const txData = await this._buildSellTransaction(mint, tokenAmount, slippageBps);

      if (!txData || !txData.transaction) {
        return { success: false, error: 'failed_build_sell_transaction' };
      }

      // 4. Ejecutar con retry
      const signature = await this._executeTransactionWithRetry(txData.transaction);

      if (!signature) {
        return { success: false, error: 'sell_transaction_failed' };
      }

      console.log(`   ✅ [LIVE] SELL exitoso: ${signature}`);
      console.log(`   🔍 Ver: https://solscan.io/tx/${signature}`);

      // Estimado de SOL recibido (98% del esperado)
      const solReceived = expectedSol * 0.98;

      return {
        success: true,
        simulated: false,
        dryRun: false,
        mint,
        tokensSold: tokenAmount,
        solReceived,
        exitPrice: valueData?.marketPrice || solReceived / tokenAmount,
        source: valueData?.source || 'market',
        signature,
        explorerUrl: `https://solscan.io/tx/${signature}`
      };

    } catch (error) {
      console.error('❌ Error en sellTokenLive:', error?.message);
      return { success: false, error: error?.message || 'live_sell_error' };
    }
  }

  // ═══════════════════════════════════════════════════════
  // HELPERS - LIVE TRADING
  // ═══════════════════════════════════════════════════════

  /**
   * Validación pre-trade
   */
  async _preTradeValidation(solAmount) {
    try {
      // Verificar balance
      const balance = await this.getBalance();
      
      if (balance < solAmount + 0.01) { // +0.01 para fees
        return {
          valid: false,
          reason: `insufficient_balance (need ${solAmount + 0.01}, have ${balance})`
        };
      }

      return { valid: true };
    } catch (error) {
      return { valid: false, reason: 'validation_error' };
    }
  }

  /**
   * Construir transacción de BUY via PumpPortal API
   */
  async _buildBuyTransaction(mint, solAmount, slippageBps) {
    try {
      const url = `${PUMPPORTAL_API}/trade-local`;
      
      const payload = {
        publicKey: this.wallet.publicKey.toBase58(),
        action: 'buy',
        mint,
        amount: solAmount,
        denominatedInSol: 'true',
        slippage: slippageBps,
        priorityFee: this.priorityFee,
        pool: 'pump'
      };

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`PumpPortal API error: ${error}`);
      }

      const data = await response.json();
      return data;

    } catch (error) {
      console.error('❌ Error building buy transaction:', error?.message);
      throw error;
    }
  }

  /**
   * Construir transacción de SELL via PumpPortal API
   */
  async _buildSellTransaction(mint, tokenAmount, slippageBps) {
    try {
      const url = `${PUMPPORTAL_API}/trade-local`;
      
      const payload = {
        publicKey: this.wallet.publicKey.toBase58(),
        action: 'sell',
        mint,
        amount: tokenAmount,
        denominatedInSol: 'false',
        slippage: slippageBps,
        priorityFee: this.priorityFee,
        pool: 'pump'
      };

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`PumpPortal API error: ${error}`);
      }

      const data = await response.json();
      return data;

    } catch (error) {
      console.error('❌ Error building sell transaction:', error?.message);
      throw error;
    }
  }

  /**
   * Ejecutar transacción con retry
   */
  async _executeTransactionWithRetry(txBase64, retries = MAX_TX_RETRIES) {
    let lastError = null;

    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        // Decodificar transacción
        const txBuf = Buffer.from(txBase64, 'base64');
        const tx = VersionedTransaction.deserialize(txBuf);

        // Firmar
        tx.sign([this.wallet]);

        // Enviar
        const signature = await this.connection.sendRawTransaction(tx.serialize(), {
          skipPreflight: false,
          maxRetries: 3
        });

        // Confirmar
        const confirmation = await this.connection.confirmTransaction(
          signature,
          'confirmed'
        );

        if (confirmation.value.err) {
          throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
        }

        return signature;

      } catch (error) {
        lastError = error;
        console.log(`   ⚠️ Intento ${attempt + 1}/${retries} falló: ${error?.message}`);
        
        if (attempt < retries - 1) {
          await new Promise(resolve => setTimeout(resolve, TX_RETRY_DELAY_MS));
        }
      }
    }

    console.error(`❌ Transacción falló tras ${retries} intentos:`, lastError?.message);
    return null;
  }

  /**
   * Obtener balance de SOL
   */
  async getBalance() {
    if (this.dryRun) {
      return 999999; // Balance artificial para PAPER
    }

    if (!this.wallet) {
      return 0;
    }

    try {
      const balance = await this.connection.getBalance(this.wallet.publicKey);
      return balance / LAMPORTS_PER_SOL;
    } catch (error) {
      console.error('❌ Error obteniendo balance:', error?.message);
      return 0;
    }
  }
}
