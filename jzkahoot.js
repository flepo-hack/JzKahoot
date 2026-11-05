const Kahoot = require('kahoot.js-updated');
const readlineSync = require('readline-sync');
const readline = require('readline');

console.log("=========================================");
console.log("          JZ KAHOOT BOT                  ");
console.log("=========================================");

// 1. Kysytään botin tiedot
const botName = readlineSync.question('Enter Bot Name: ');
const pin = readlineSync.question('Enter Kahoot PIN: ');

console.log("\n[INFO] Press Capital 'Q' at any time to close the bot.\n");

// 2. Laitetaan näppäimistön kuuntelu päälle (Iso Q sulkee)
readline.emitKeypressEvents(process.stdin);
if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
}
process.stdin.on('keypress', (str, key) => {
    if (str === 'Q') {
        console.log('\n[!] Capital Q pressed. Exiting JZ Kahoot Bot. Goodbye!');
        process.exit(0);
    }
    if (key.ctrl && key.name === 'c') {
        process.exit(0);
    }
});

const client = new Kahoot();
let questionCount = 0;

console.log(`[*] Connecting to game ${pin} as ${botName}...`);

// 3. Yhdistetään peliin
client.join(pin, botName).catch(err => {
    console.log('[-] Failed to join:', err.description || err);
    process.exit(1);
});

client.on('joined', () => {
    console.log(`[+] Successfully joined the game! Waiting for it to start...`);
});

// 4. Kysymysten käsittely ja viive-logiikka
client.on('QuestionStart', (question) => {
    questionCount++;
    console.log(`\n[!] Question ${questionCount} started!`);

    let delayMs = 150; // Normaali, erittäin nopea vastausaika

    // Joka 3. kysymys: lisätään inhimillinen viive (2000 - 4000 millisekuntia)
    if (questionCount % 3 === 0) {
        delayMs = Math.floor(Math.random() * 2000) + 2000; 
        console.log(`[*] Adding human delay for this round: ${delayMs}ms`);
    } else {
        console.log(`[*] Answering fast! Delay: ${delayMs}ms`);
    }

    setTimeout(() => {
        // Valitaan satunnainen vastaus, jotta peli etenee automaattisesti
        const choiceCount = question.choices ? question.choices.length : 4;
        const randomAnswer = Math.floor(Math.random() * choiceCount);
        
        console.log(`[+] Answering with option ${randomAnswer}`);
        question.answer(randomAnswer);
    }, delayMs);
});

client.on('Disconnect', (reason) => {
    console.log('\n[-] Disconnected from the game:', reason);
    process.exit(0);
});
