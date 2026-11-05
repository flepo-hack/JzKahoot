const Kahoot = require('kahoot.js-updated');
const readlineSync = require('readline-sync');
const readline = require('readline');
const axios = require('axios');

console.log("=========================================");
console.log("        JZ KAHOOT BOT - V2.0 PRO         ");
console.log("=========================================");

// 1. Kysytään asetukset käyttäjältä
const pin = readlineSync.question('Enter Kahoot PIN: ');
const botNameInput = readlineSync.question('Enter Bot Name: ');
// Lisätään nimen perään näkymätön merkki kiertämään Kahootin nimiblokkeja
const botName = botNameInput + '\u200B';

console.log("\n[?] Miten haluat botin pelaavan?");
console.log("1 = RAGE MODE (100% oikein, erittäin nopea)");
console.log("2 = LEGIT MODE (Inhimilliset viiveet, ~15% tahallisia virheitä välttääkseen potkut)");
const mode = readlineSync.question('Valitse tila (1 tai 2): ') || '2';

console.log("\n[?] (VAPAAEHTOINEN) Saadaksesi 100% oikeat vastaukset, liitä tähän visan linkki tai UUID.");
console.log("Esimerkki: https://create.kahoot.it/details/123e4567-e89b-12d3-a456-426614174000");
const quizUrl = readlineSync.question('Linkki/UUID (paina Enter ohittaaksesi): ');

console.log("\n[INFO] Paina Isoa 'Q' milloin tahansa sulkeaksesi botin.\n");

// Näppäimistön kuuntelu (Iso Q sulkee)
readline.emitKeypressEvents(process.stdin);
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.on('keypress', (str, key) => {
    if (str === 'Q') {
        console.log('\n[!] Iso Q painettu. Botti suljetaan. Morjes!');
        process.exit(0);
    }
    if (key.ctrl && key.name === 'c') process.exit(0);
});

// Pääohjelma
async function startBot() {
    let answerKey = [];

    // Jos linkki/UUID annettiin, ladataan vastaukset Kahootin rajapinnasta
    if (quizUrl.trim() !== '') {
        const uuidMatch = quizUrl.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i);
        if (uuidMatch) {
            const uuid = uuidMatch[0];
            console.log(`[*] Etsitään vastauksia visalle: ${uuid}...`);
            try {
                const response = await axios.get(`https://create.kahoot.it/rest/kahoots/${uuid}`);
                answerKey = response.data.questions;
                console.log(`[+] ONNISTUI! Ladattiin ${answerKey.length} kysymyksen vastaukset.\n`);
            } catch (error) {
                console.log(`[-] Virhe ladattaessa vastauksia. Peli on täysin suojattu tai UUID on väärä.`);
                console.log(`[-] Botti siirtyy arvaustilaan.\n`);
            }
        } else {
            console.log("[-] Virheellinen linkki tai UUID. Botti siirtyy arvaustilaan.\n");
        }
    } else {
        console.log("[!] Ei linkkiä. Botti joutuu arvaamaan kaikki vastaukset.\n");
    }

    const client = new Kahoot();
    console.log(`[*] Yhdistetään peliin ${pin} nimellä ${botNameInput}...`);

    client.join(pin, botName).catch(err => {
        console.log('[-] Liittyminen epäonnistui:', err.description || err);
        process.exit(1);
    });

    client.on('joined', () => {
        console.log(`[+] Yhteys luotu! Odotetaan pelin alkamista...`);
    });

    let questionIndex = 0;

    client.on('QuestionStart', (question) => {
        console.log(`\n[!] Kysymys ${questionIndex + 1} alkoi!`);
        
        let choiceCount = question.choices ? question.choices.length : 4;
        let finalAnswerIndex = Math.floor(Math.random() * choiceCount); // Oletuksena arvaus
        let knowAnswer = false;

        // Etsitään oikea vastaus, jos data ladattiin onnistuneesti
        if (answerKey[questionIndex]) {
            const choicesData = answerKey[questionIndex].choices;
            if (choicesData) {
                finalAnswerIndex = choicesData.findIndex(c => c.correct === true);
                knowAnswer = true;
            }
        }

        let delayMs = 500; // Default

        if (mode === '1') {
            // RAGE MODE: Nopein turvallinen viive (300-800ms) ettei Kahoot heitä ulos bottina
            delayMs = Math.floor(Math.random() * 500) + 300;
            console.log(`[*] Rage mode päällä. Isketään oikea vastaus tauluun!`);
        } else {
            // LEGIT MODE: Inhimillinen viive (2s - 5s)
            delayMs = Math.floor(Math.random() * 3000) + 2000;
            
            // 15 % mahdollisuus tahalliseen virheeseen vain uskottavuuden vuoksi
            if (knowAnswer && Math.random() < 0.15) {
                console.log(`[*] Legit mode: Tehdään tahallinen virhe, ettei opettaja huomaa...`);
                let wrongAnswers = [0, 1, 2, 3].filter(a => a !== finalAnswerIndex && a < choiceCount);
                finalAnswerIndex = wrongAnswers[Math.floor(Math.random() * wrongAnswers.length)];
            } else if (knowAnswer) {
                console.log(`[*] Legit mode: Vastataan oikein inhimillisellä viiveellä.`);
            }
        }

        if (!knowAnswer) {
            console.log(`[*] Vastausta ei tiedetä. Arvataan vaihtoehto ${finalAnswerIndex}.`);
        }

        setTimeout(() => {
            console.log(`[+] Lähetettiin vastaus: ${finalAnswerIndex} (Viive: ${delayMs}ms)`);
            question.answer(finalAnswerIndex);
        }, delayMs);

        questionIndex++;
    });

    client.on('Disconnect', (reason) => {
        console.log('\n[-] Yhteys peliin katkesi:', reason);
        process.exit(0);
    });
}

startBot();
            
