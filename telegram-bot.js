
import TelegramBot from 'node-telegram-bot-api';
import puppeteer from 'puppeteer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import http from 'http';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// استخدم توكن البوت الخاص بك هنا
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'YOUR_BOT_TOKEN_HERE';

// إنشاء البوت
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Create screenshots directory if it doesn't exist
if (!fs.existsSync('screenshots')) {
    fs.mkdirSync('screenshots');
}

let browser;

// دالة لتثبيت المتصفح تلقائياً
async function ensureBrowserInstalled() {
    try {
        const { execSync } = await import('child_process');
        console.log('🔍 Checking if Chrome browser is available...');
        
        // محاولة تشغيل puppeteer للتحقق من وجود المتصفح
        const testBrowser = await puppeteer.launch({ 
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        await testBrowser.close();
        console.log('✅ Chrome browser is available');
        return true;
    } catch (error) {
        if (error.message.includes('Could not find Chrome')) {
            console.log('⚠️ Chrome not found, installing...');
            try {
                const { execSync } = await import('child_process');
                execSync('npx puppeteer browsers install chrome', { 
                    stdio: 'inherit',
                    timeout: 300000 // 5 minutes timeout
                });
                console.log('✅ Chrome browser installed successfully');
                return true;
            } catch (installError) {
                console.error('❌ Failed to install Chrome:', installError.message);
                return false;
            }
        } else {
            console.error('❌ Browser check failed:', error.message);
            return false;
        }
    }
}

async function takeScreenshot(url) {
    try {
        console.log(`Taking screenshot of: ${url}`);

        if (!browser) {
            // التأكد من تثبيت المتصفح قبل إنشائه
            const browserAvailable = await ensureBrowserInstalled();
            if (!browserAvailable) {
                throw new Error('Failed to install or find Chrome browser');
            }

            browser = await puppeteer.launch({
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--no-first-run',
                    '--no-zygote',
                    '--single-process',
                    '--disable-gpu'
                ]
            });
        }

        const page = await browser.newPage();

        // Set mobile user agent
        await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 14_7_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.2 Mobile/15E148 Safari/604.1');

        // Set mobile viewport
        await page.setViewport({
            width: 375,
            height: 667,
            isMobile: true,
            hasTouch: true
        });

        // Navigate to URL
        await page.goto(url, {
            waitUntil: 'networkidle2',
            timeout: 20000
        });

        // Wait a bit for page to fully load
        await new Promise(resolve => setTimeout(resolve, 200));

        let creatorRewardsAmount = { found: false };

        // Simplified button clicking logic
        try {
            await page.waitForSelector('body', { timeout: 1000 });

            // Look for "continue to web" button first
            console.log('Looking for "continue to web" button...');
            let continueClicked = false;

            const continueElements = await page.evaluate(() => {
                const elements = [];
                const walker = document.createTreeWalker(
                    document.body,
                    NodeFilter.SHOW_TEXT,
                    null,
                    false
                );

                let node;
                while (node = walker.nextNode()) {
                    if (node.textContent.toLowerCase().includes('continue to web')) {
                        elements.push(node.parentElement);
                    }
                }
                return elements.map(el => ({
                    tagName: el.tagName,
                    textContent: el.textContent,
                    className: el.className,
                    id: el.id
                }));
            });

            if (continueElements.length > 0) {
                const clickSuccess = await page.evaluate(() => {
                    const walker = document.createTreeWalker(
                        document.body,
                        NodeFilter.SHOW_TEXT,
                        null,
                        false
                    );

                    let node;
                    while (node = walker.nextNode()) {
                        if (node.textContent.toLowerCase().includes('continue to web')) {
                            const element = node.parentElement;
                            if (element && (element.tagName === 'BUTTON' || element.tagName === 'A' || element.onclick || element.style.cursor === 'pointer')) {
                                element.click();
                                return true;
                            }
                        }
                    }
                    return false;
                });

                if (clickSuccess) {
                    continueClicked = true;
                    console.log('Successfully clicked "continue to web"');
                }
            }

            if (continueClicked) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }

            // Look for "Accept all" buttons
            console.log('Looking for accept/agree buttons...');
            const acceptClicked = await page.evaluate(() => {
                const walker = document.createTreeWalker(
                    document.body,
                    NodeFilter.SHOW_TEXT,
                    null,
                    false
                );

                let node;
                while (node = walker.nextNode()) {
                    const text = node.textContent.toLowerCase();
                    if (text.includes("accept all") || text.includes("accept") || text.includes("i agree") || text.includes("agree")) {
                        const element = node.parentElement;
                        if (element && (element.tagName === 'BUTTON' || element.tagName === 'A' || element.onclick || element.style.cursor === 'pointer')) {
                            element.scrollIntoView({ behavior: 'smooth', block: 'center' });
                            element.click();
                            return true;
                        }
                    }
                }
                return false;
            });

            if (acceptClicked) {
                console.log('Successfully clicked accept button');
                await new Promise(resolve => setTimeout(resolve, 100));
            }

            // Look for "I'm ready to pump" button
            console.log('Looking for "I\'m ready to pump" button...');
            const pumpClicked = await page.evaluate(() => {
                const walker = document.createTreeWalker(
                    document.body,
                    NodeFilter.SHOW_TEXT,
                    null,
                    false
                );

                let node;
                while (node = walker.nextNode()) {
                    const text = node.textContent.toLowerCase();
                    if (text.includes("i'm ready to pump") || text.includes("ready to pump") || text.includes("i'm ready")) {
                        const element = node.parentElement;
                        if (element && (element.tagName === 'BUTTON' || element.tagName === 'A' || element.onclick || element.style.cursor === 'pointer')) {
                            element.scrollIntoView({ behavior: 'smooth', block: 'center' });
                            element.click();
                            return true;
                        }
                    }
                }
                return false;
            });

            if (pumpClicked) {
                console.log('Successfully clicked "I\'m ready to pump" button');
                await new Promise(resolve => setTimeout(resolve, 100));
            }

            // Look for creator rewards total amount
            console.log('Looking for creator rewards total amount...');
            creatorRewardsAmount = await page.evaluate(() => {
                const walker = document.createTreeWalker(
                    document.body,
                    NodeFilter.SHOW_TEXT,
                    null,
                    false
                );
                
                let creatorRewardsFound = false;
                let totalFound = false;
                let node;
                
                while (node = walker.nextNode()) {
                    const text = node.textContent?.toLowerCase().trim();
                    
                    if (!creatorRewardsFound && text === 'creator rewards') {
                        creatorRewardsFound = true;
                        console.log('Found creator rewards text');
                        continue;
                    }
                    
                    if (creatorRewardsFound && !totalFound && text === 'total') {
                        totalFound = true;
                        console.log('Found total text after creator rewards');
                        continue;
                    }
                    
                    if (creatorRewardsFound && totalFound) {
                        const moneyPattern = /^\$\d+\.\d{2}$/;
                        if (moneyPattern.test(text)) {
                            return {
                                found: true,
                                amount: text,
                                fullText: text,
                                elementType: node.parentElement.tagName,
                                className: node.parentElement.className || '',
                                position: 'Found directly after total under creator rewards'
                            };
                        }
                    }
                }
                
                // Fallback: broader search if exact sequence not found
                const allElements = Array.from(document.querySelectorAll('*'));
                for (let element of allElements) {
                    const text = element.textContent?.trim();
                    if (text && /^\$\d+\.\d{2}$/.test(text)) {
                        const parentText = element.parentElement?.textContent?.toLowerCase() || '';
                        const grandParentText = element.parentElement?.parentElement?.textContent?.toLowerCase() || '';
                        
                        if (parentText.includes('creator rewards') || grandParentText.includes('creator rewards') ||
                            parentText.includes('total') || grandParentText.includes('total')) {
                            return {
                                found: true,
                                amount: text,
                                fullText: text,
                                elementType: element.tagName,
                                className: element.className || '',
                                position: 'Found dollar amount near creator rewards/total (fallback method)'
                            };
                        }
                    }
                }
                
                return { found: false, message: 'Creator rewards total amount not found' };
            });

            if (creatorRewardsAmount.found) {
                console.log('🎯 CREATOR REWARDS TOTAL FOUND:');
                console.log(`   Amount: ${creatorRewardsAmount.amount}`);
            } else {
                console.log('❌ Creator rewards total not found');
            }

        } catch (popupError) {
            console.log('Error during button handling:', popupError.message);
        }

        // Wait for any final animations or content changes
        await new Promise(resolve => setTimeout(resolve, 100));

        // Generate filename with timestamp
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `screenshot-${timestamp}.png`;
        const filepath = path.join('screenshots', filename);

        await page.screenshot({
            path: filepath,
            fullPage: true,
            type: 'png'
        });

        await page.close();

        console.log(`Screenshot saved: ${filename}`);
        return { filename, creatorRewards: creatorRewardsAmount };

    } catch (error) {
        console.error('Error taking screenshot:', error);
        throw error;
    }
}

// معالج الرسائل
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    // التحقق من أن الرسالة تحتوي على نص
    if (!text) return;

    // رسالة الترحيب
    if (text === '/start') {
        bot.sendMessage(chatId, `مرحباً بك 🌹

ارسل عنوان محفظة SOL للفحص 🔍`);
        return;
    }

    // رسالة المساعدة
    if (text === '/help') {
        bot.sendMessage(chatId, `
📖 المساعدة:

🌐 أرسل رابط موقع مثل:
• https://pump.fun/coin/...
• google.com
• github.com

💰 أو أرسل عنوان محفظة مثل:
• HjY2bjjBtPjp1V5muestDxd6ZehpCFG5Dt4ABA9MyGSr

⚡ البوت سيقوم تلقائياً بـ:
1. فتح الموقع
2. النقر على "continue to web"
3. النقر على "accept all"
4. النقر على "I'm ready to pump"
5. البحث عن مبلغ creator rewards
6. أخذ لقطة شاشة وإرسالها لك

/start - البدء
/help - المساعدة
        `);
        return;
    }

    // البحث عن عناوين المحافظ في النص
    const walletPattern = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;
    const walletMatches = text.match(walletPattern) || [];
    
    // البحث عن الروابط في النص
    const urlPattern = /(https?:\/\/[^\s]+)/g;
    const urlMatches = text.match(urlPattern) || [];
    
    // التحقق من وجود نص يبدو كرابط بدون http
    const domainPattern = /([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}/g;
    const domainMatches = text.match(domainPattern) || [];
    
    // جمع كل العناوين والروابط
    let addressesToProcess = [];
    
    // إضافة عناوين المحافظ
    walletMatches.forEach(wallet => {
        if (wallet.length >= 32 && wallet.length <= 44) {
            addressesToProcess.push({
                type: 'wallet',
                original: wallet,
                url: `https://pump.fun/profile/${wallet}?tab=coins`
            });
        }
    });
    
    // إضافة الروابط
    urlMatches.forEach(url => {
        addressesToProcess.push({
            type: 'url',
            original: url,
            url: url
        });
    });
    
    // إضافة النطاقات (domains) إذا لم توجد روابط صريحة
    if (urlMatches.length === 0) {
        domainMatches.forEach(domain => {
            if (!walletMatches.includes(domain)) {
                addressesToProcess.push({
                    type: 'domain',
                    original: domain,
                    url: `https://${domain}`
                });
            }
        });
    }
    
    // إزالة التكرارات
    addressesToProcess = addressesToProcess.filter((item, index, self) => 
        index === self.findIndex(t => t.url === item.url)
    );

    // التحقق من وجود عناوين للمعالجة
    if (addressesToProcess.length === 0) {
        bot.sendMessage(chatId, '❌ لم يتم العثور على عناوين محافظ أو روابط صحيحة في رسالتك');
        return;
    }

    let processingMsg = null;
    
    // إرسال رسالة تأكيد البدء
    if (addressesToProcess.length > 1) {
        processingMsg = await bot.sendMessage(chatId, 
            `🔍 تم العثور على ${addressesToProcess.length} عنوان/رابط\n⏳ جاري المعالجة...\nيرجى الانتظار قليلاً`
        );
    } else {
        // رسالة للعنوان الواحد
        processingMsg = await bot.sendMessage(chatId, 
            `⏳ انتظر قليلاً جاري الفحص...`
        );
    }

    try {
        let successCount = 0;
        let errorCount = 0;
        
        // معالجة كل عنوان على حدة
        for (let i = 0; i < addressesToProcess.length; i++) {
            const item = addressesToProcess[i];
            
            try {
                // تحديث رسالة التقدم للعناوين المتعددة فقط
                if (addressesToProcess.length > 1 && processingMsg) {
                    await bot.editMessageText(
                        `🔍 تم العثور على ${addressesToProcess.length} عنوان/رابط\n⏳ جاري معالجة ${i + 1}/${addressesToProcess.length}...\n\nالحالي: ${item.type === 'wallet' ? 'محفظة' : 'رابط'}`,
                        { chat_id: chatId, message_id: processingMsg.message_id }
                    );
                }

                // أخذ لقطة الشاشة
                const result = await takeScreenshot(item.url);
                
                // إعداد النص المرافق للصورة
                let caption = '';
                
                // إضافة رقم الفحص فقط للعناوين المتعددة
                if (addressesToProcess.length > 1) {
                    caption += `✅ فحص رقم ${i + 1}/${addressesToProcess.length}\n\n`;
                }
                
                if (item.type === 'wallet') {
                    caption += `💰 المحفظة: ${item.original}\n\n`;
                } else {
                    caption += `🌐 الرابط: ${item.original}\n\n`;
                }
                
                if (result.creatorRewards.found) {
                    caption += `💰 Creator Rewards Total: ${result.creatorRewards.amount}\n\n`;
                } else {
                    caption += `💰 Creator Rewards: غير متوفر\n\n`;
                }
                
                // إرسال الصورة مع زر إنتقال
                const imagePath = path.join('screenshots', result.filename);
                await bot.sendPhoto(chatId, imagePath, { 
                    caption: caption,
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [[
                            {
                                text: 'إنتقال 🔗',
                                url: item.url
                            }
                        ]]
                    }
                });

                // حذف الصورة بعد الإرسال لتوفير المساحة
                setTimeout(() => {
                    try {
                        fs.unlinkSync(imagePath);
                    } catch (err) {
                        console.log('Error deleting file:', err.message);
                    }
                }, 60000);
                
                successCount++;
                
                // انتظار قصير بين المعالجات لتجنب الحمل الزائد
                if (i < addressesToProcess.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
                
            } catch (error) {
                console.error(`Error processing ${item.original}:`, error);
                errorCount++;
                
                // إرسال رسالة خطأ للعنوان الحالي
                await bot.sendMessage(chatId, 
                    `❌ خطأ في معالجة ${item.type === 'wallet' ? 'المحفظة' : 'الرابط'}: ${item.original}\n\nالخطأ: ${error.message}`
                );
            }
        }
        
        // حذف رسالة "جاري المعالجة"
        if (processingMsg) {
            await bot.deleteMessage(chatId, processingMsg.message_id);
        }
        
        // إرسال ملخص النتائج للعناوين المتعددة فقط
        if (addressesToProcess.length > 1) {
            await bot.sendMessage(chatId, 
                `📊 ملخص النتائج:\n\n✅ تم بنجاح: ${successCount}\n❌ فشل: ${errorCount}\n📝 المجموع: ${addressesToProcess.length}`
            );
        }

    } catch (error) {
        console.error('Error processing requests:', error);
        
        // حذف رسالة "جاري المعالجة" في حالة الخطأ للعناوين المتعددة فقط
        if (processingMsg) {
            try {
                await bot.deleteMessage(chatId, processingMsg.message_id);
            } catch (e) {
                // تجاهل أخطاء حذف الرسالة
            }
        }
        
        await bot.sendMessage(chatId, `❌ حدث خطأ عام أثناء معالجة طلبك:\n${error.message}`);
    }
});

// التعامل مع الأخطاء
bot.on('error', (error) => {
    console.error('Telegram Bot Error:', error);
});

// إعداد خادم HTTP بسيط لـ UptimeRobot
const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    
    if (req.url === '/health') {
        res.end(JSON.stringify({
            status: 'ok',
            message: 'Telegram Bot is running',
            timestamp: new Date().toISOString()
        }));
    } else {
        // صفحة HTML بسيطة لجميع الروابط الأخرى
        const html = `
<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>🤖 Telegram Bot Status</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            margin: 0;
            padding: 20px;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .container {
            background: white;
            padding: 30px;
            border-radius: 15px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.2);
            text-align: center;
            max-width: 400px;
            width: 100%;
        }
        .status {
            color: #28a745;
            font-size: 24px;
            margin-bottom: 20px;
        }
        .info {
            color: #666;
            margin-bottom: 10px;
        }
        .timestamp {
            color: #999;
            font-size: 12px;
            margin-top: 20px;
        }
        .health-link {
            display: inline-block;
            margin-top: 15px;
            padding: 8px 16px;
            background: #007bff;
            color: white;
            text-decoration: none;
            border-radius: 5px;
        }
        .health-link:hover {
            background: #0056b3;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="status">🤖 البوت يعمل بنجاح</div>
        <div class="info">✅ الحالة: نشط</div>
        <div class="info">🔄 مراقب بواسطة UptimeRobot</div>
        <div class="info">📱 بوت فحص محافظ SOL</div>
        <a href="/health" class="health-link">🔍 Health Check API</a>
        <div class="timestamp">آخر فحص: ${new Date().toLocaleString('ar-SA')}</div>
    </div>
</body>
</html>
        `;
        res.end(html);
    }
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 HTTP server is running on port ${PORT}`);
    console.log(`🔍 Health check available at: http://localhost:${PORT}/health`);
});

// رسالة عند بدء تشغيل البوت
console.log('🤖 Telegram Bot is running...');
console.log('Make sure to set TELEGRAM_BOT_TOKEN environment variable');

// Cleanup on exit
process.on('SIGINT', async () => {
    console.log('🛑 Shutting down...');
    
    if (browser) {
        await browser.close();
    }
    
    server.close(() => {
        console.log('🌐 HTTP server closed');
    });
    
    process.exit(0);
});
