
import TelegramBot from 'node-telegram-bot-api';
import puppeteer from 'puppeteer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

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

async function takeScreenshot(url) {
    try {
        console.log(`Taking screenshot of: ${url}`);

        if (!browser) {
            browser = await puppeteer.launch({
                headless: true,
                executablePath: puppeteer.executablePath(),
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--no-first-run',
                    '--no-zygote',
                    '--single-process',
                    '--disable-gpu',
                    '--disable-background-timer-throttling',
                    '--disable-backgrounding-occluded-windows',
                    '--disable-renderer-backgrounding'
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
            timeout: 25000
        });

        // Wait a bit for page to fully load
        await new Promise(resolve => setTimeout(resolve, 300));

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
                await new Promise(resolve => setTimeout(resolve, 150));
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
                await new Promise(resolve => setTimeout(resolve, 150));
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
                await new Promise(resolve => setTimeout(resolve, 150));
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
        await new Promise(resolve => setTimeout(resolve, 150));

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
                    await new Promise(resolve => setTimeout(resolve, 1000));
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

// رسالة عند بدء تشغيل البوت
console.log('🤖 Telegram Bot is running...');
console.log('Make sure to set TELEGRAM_BOT_TOKEN environment variable');

// Add Express server for Render
import express from 'express';
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('🤖 Telegram Bot is running on Render!');
});

app.listen(PORT, () => {
  console.log(`🌐 Web server running on port ${PORT}`);
});

// Cleanup on exit
process.on('SIGINT', async () => {
    if (browser) {
        await browser.close();
    }
    process.exit(0);
});
