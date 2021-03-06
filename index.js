const puppeteer = require('puppeteer');
const { Worker, isMainThread, parentPort } = require('worker_threads');
const numCPUs = require('os').cpus().length;
const fs = require('fs');
const stopWords = require('./stopWords.json');

const APRIL = '04';
const OCTOBER = '10';

async function getWords(path, removeStopWords) {
    const browser = await puppeteer.launch();
    const page = await browser.newPage();
    const link = `https://churchofjesuschrist.org${path}`;
    await page.goto(link);
    const author = await page.evaluate(
        () => document.querySelector('.author-name').innerText.match(/\w+$/)[0]
    );
    const allTalkWords = await page.evaluate(() => [
        ...document.querySelectorAll('.body-block p')
    ].map(({ innerText }) => innerText)
        .join(' ').toLowerCase()
        .replace(/(\w+)('|’)(\w+)/g, '$1$3 ')
        .replace(/\d+[^(st|nd|rd|th)]/g, ' ')
        .replace(/[^\w+]/g, ' ')
        .split(/\s+/)
    ).catch(() => browser.close());

    await browser.close();

    return {
        author,
        allTalkWords: removeStopWords ?
            allTalkWords.filter(word => (
                (word.length > 2)
                &&
                !stopWords.includes(word.toLowerCase())
            ))
            :
            allTalkWords,
    };
}

async function getWordCount(year = 2021, month = APRIL, removeStopWords = true) {
    if (isMainThread) {
        console.log(`Getting conference talks from ${month} ${year}`);

        const browser = await puppeteer.launch();
        const page = await browser.newPage();

        const conferenceMainPage = `https://www.churchofjesuschrist.org/study/general-conference/${year}/${month}?lang=eng`;
        await page.goto(conferenceMainPage);

        const conferenceTalks = await page.evaluate(
            () => Array.from(document.querySelectorAll('.doc-map .doc-map a')).map(a => a.getAttribute('href'))
        ).catch(() => browser.close());

        await browser.close();

        const { length: conferenceTalkLength } = conferenceTalks;
        console.log(`Found ${conferenceTalkLength} talks.`);

        const talksPerWorker = ~~(conferenceTalkLength / numCPUs);
        const extraTalks = conferenceTalkLength % numCPUs;

        let conferenceWords = [];
        let workersFinished = 0;

        for (let i = 0; i < numCPUs; i++) {
            const worker = new Worker(__filename);
            const start = (i * talksPerWorker) + Math.min(i, extraTalks);
            const end = ((i + 1) * talksPerWorker) + Math.min(i + 1, extraTalks);
            let msg = { id: i, conferenceTalkPortion: conferenceTalks.slice(start, end) };
            worker.postMessage(msg);
            worker.on('message', data => {
                console.log(`worker data sent`);
                conferenceWords.push(...data);
                workersFinished++;
                console.log(numCPUs, workersFinished);
                if (workersFinished === numCPUs) {
                    
                    const wordsBySpeaker = conferenceWords.map(({ value }) => value).filter(Boolean);

                    console.log(`Getting all words...`);
                    let allWords = [];
                    wordsBySpeaker.forEach(({ allTalkWords }) => allWords.push(...allTalkWords));

                    console.log(`counting each word... length: ${allWords.length}`);
                    let wordsByPopularity = {};
                    allWords.forEach(word => wordsByPopularity[word] = (wordsByPopularity[word] || 0) + 1);

                    console.log(`Sorting all unique words...`);
                    const allSortedWords = Object.entries(wordsByPopularity)
                        .sort(([wordA], [wordB]) => wordA < wordB ? -1 : 1)
                        .sort(([, countA], [, countB]) => countB - countA)
                        .map(([word, wordCount], i) => {
                            const place = `${i + 1}`.padEnd(3, " ");
                            const pascalCasedWord = word.replace(/^./, l => l.toUpperCase()).padEnd(24, " ");
                            return `${place}: ${pascalCasedWord}: ${wordCount}`;
                        });

                    const jsonFilePrefix = removeStopWords ? 'core' : 'all';
                    fs.writeFileSync(`${jsonFilePrefix}-${year}-${month}-conference.json`, JSON.stringify(allSortedWords));
                    console.log('Complete!');
                }
            })
        }
    } else {
        parentPort.on('message', ({ id, conferenceTalkPortion }) => {
            console.log(`Worker ${id}: counting ${conferenceTalkPortion.length} talks.`);
            let promises = [];
            conferenceTalkPortion.forEach(path => promises.push(getWords(path, removeStopWords)));

            Promise.allSettled(promises)
                .then(conferenceWords => {
                    console.log(`Finished. Sending back ${conferenceWords.length} conference talks`);
                    parentPort.postMessage(conferenceWords);
                    process.exit();
                });
        });
    }
}

getWordCount(2021, APRIL);