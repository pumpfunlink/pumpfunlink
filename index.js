const TelegramBot = require('node-telegram-bot-api');
const express = require('express');

// قراءة التوكن من متغيرات البيئة
const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token) {
  console.error('TELEGRAM_BOT_TOKEN is not set in environment variables');
  process.exit(1);
}

// إنشاء خادم Express
const app = express();
const PORT = process.env.PORT || 5000;

// أنشئ البوت
const bot = new TelegramBot(token, { polling: true });

console.log('Bot started successfully...');

// متغير لتتبع حالة البوت
let botStatus = 'running';
let startTime = new Date();

// صفحة رئيسية للمراقبة
app.get('/', (req, res) => {
  const uptime = Math.floor((new Date() - startTime) / 1000);
  const hours = Math.floor(uptime / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);
  const seconds = uptime % 60;
  
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Telegram Bot Status</title>
      <meta charset="UTF-8">
      <style>
        body { 
          font-family: 'Segoe UI', Arial, sans-serif; 
          margin: 40px; 
          background: #0d1117; 
          color: #e6edf3;
        }
        .container { 
          background: #161b22; 
          padding: 30px; 
          border-radius: 12px; 
          box-shadow: 0 8px 32px rgba(0,0,0,0.3);
          border: 1px solid #30363d;
        }
        .status { 
          padding: 15px; 
          border-radius: 8px; 
          margin: 20px 0; 
        }
        .running { 
          background: #0d4429; 
          color: #3fb950; 
          border: 1px solid #238636; 
        }
        .info { 
          background: #0c2d6b; 
          color: #58a6ff; 
          border: 1px solid #1f6feb; 
        }
        h1 { 
          color: #f0f6fc; 
          text-align: center;
          margin-bottom: 30px;
        }
        .time { 
          font-size: 18px; 
          font-weight: bold; 
          color: #ffa657;
        }
        p { 
          color: #8b949e; 
          text-align: center; 
          margin-top: 30px;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>🤖 Telegram Bot Monitor</h1>
        <div class="status running">
          <strong>Status:</strong> ${botStatus} ✅
        </div>
        <div class="info">
          <strong>Uptime:</strong> <span class="time">${hours}h ${minutes}m ${seconds}s</span>
        </div>
        <div class="info">
          <strong>Started:</strong> ${startTime.toLocaleString('ar-EG')}
        </div>
        <div class="info">
          <strong>Port:</strong> ${PORT}
        </div>
        <p>This page is used for monitoring the Telegram bot with UptimeRobot.</p>
      </div>
    </body>
    </html>
  `);
});

// API endpoint للحصول على حالة البوت
app.get('/status', (req, res) => {
  res.json({
    status: botStatus,
    uptime: Math.floor((new Date() - startTime) / 1000),
    startTime: startTime.toISOString()
  });
});

// بدء الخادم
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Web server started on port ${PORT}`);
  console.log(`Monitor URL: http://localhost:${PORT}`);
});

// دالة لتوليد رابط pump.fun
function generatePumpLink(address) {
  return `https://pump.fun/profile/${address}?tab=coins`;
}

// دالة لاختصار العنوان (xxx...xxx)
function shortenAddress(address) {
  return `${address.slice(0, 3)}...${address.slice(-3)}`;
}

// معالج أخطاء البوت
bot.on('error', (error) => {
  console.error('Bot error:', error);
  botStatus = 'error';
});

bot.on('polling_error', (error) => {
  console.error('Polling error:', error);
  botStatus = 'polling_error';
});

// عند استلام رسالة
bot.on('message', (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text.trim();

  // تقسيم النص لأسطر (عناوين المحافظ)
  const addresses = text.split(/\s+/).filter(a => a.length > 20);

  if (addresses.length === 0) {
    bot.sendMessage(chatId, '📌 أرسل لي عناوين المحافظ كل واحدة بسطر.');
    return;
  }

  // توليد أزرار
  const buttons = addresses.map(addr => {
    return [{ text: shortenAddress(addr), url: generatePumpLink(addr) }];
  });

  // إرسال الأزرار
  bot.sendMessage(chatId, 'اختر المحفظة 👇', {
    reply_markup: {
      inline_keyboard: buttons
    }
  });
});