import marked, {TokensList} from "marked";
import * as fs from "fs";
import * as path from "path";
import * as inquirer from "inquirer";
import chalk from "chalk";
import OBSWebSocket from "obs-websocket-js";
import TerminalRenderer from 'marked-terminal';

const SCRIPTS_LOCATION = './scripts';

const prompt = inquirer.createPromptModule();
const obs: OBSWebSocket = new OBSWebSocket();

marked.setOptions({
    renderer: new TerminalRenderer({
        width: 80,
        reflowText: true,
        heading: chalk.red.bold,
        firstHeading: chalk.green.underline.bold,
    })
});

(async function () {
    await obs.connect({address: 'localhost:4444', password: ''});
    const scriptFiles = await findMarkdownFilesIn(SCRIPTS_LOCATION);

    const {scriptFileSelected} = await prompt({
        type: "list",
        message: "Select your script:",
        name: "scriptFileSelected",
        choices: scriptFiles
    });

    const scriptContent = await readScriptContent(SCRIPTS_LOCATION, scriptFileSelected);

    const scriptTitle = scriptContent[0].type === "heading" ? scriptContent[0].text : scriptFileSelected;
    const lines = scriptContent.filter((token) => token.type !== "space" && token.type !== "heading") as marked.Tokens.Paragraph[];

    for (const [index, line] of lines.entries()) {
        console.clear()
        console.log(marked(`# Script: ${scriptTitle}`))
        console.log(marked(line.raw))
        const {textToRecord} = await prompt({
            type: "list", message: "Ready to record ?", name: "textToRecord", choices: [
                ACTIONS.RECORD,
                ACTIONS.IGNORE
            ]
        });

        if (textToRecord !== ACTIONS.RECORD) {
            continue;
        }

        while (true) {
            await setFilename(obs, `${scriptFileSelected}-${index}`)
            await stopRecording(obs);
            await startRecording(obs)

            const {takeFeedback} = await prompt({
                name: "takeFeedback", message: "How was the take", type: "list", choices: [
                    ACTIONS.GOOD,
                    ACTIONS.RETAKE,
                    ACTIONS.SKIP
                ]
            });

            if (takeFeedback === ACTIONS.GOOD) {
                await stopRecording(obs);
                break;
            }
            if (takeFeedback === ACTIONS.RETAKE) {
                await stopRecording(obs);
                continue;
            }
        }

    }
})()


async function findMarkdownFilesIn(location: string): Promise<string[]> {
    return new Promise((resolve, reject) => {
        fs.readdir(location, (err, scriptDir) => {
            if (err) {
                reject(err);
                return;
            }
            resolve(scriptDir.filter(file => file.match(".*\\.md")))
        });
    });
}

async function stopRecording(obs: OBSWebSocket): Promise<string> {
    const status = await obs.send("GetRecordingStatus");
    //console.debug("Recording status", status)
    if (status.isRecording) {
        return new Promise(async resolve => {
            obs.on("RecordingStopped", ({recordingFilename}) => {
                obs.removeAllListeners("RecordingStopped")
                //console.debug("Recording stopped for sure")
                resolve(recordingFilename);
            })
            await obs.send("StopRecording")

            //console.debug("Recording stopped")
        })
    }
    return status.recordingFilename as string;
}

async function startRecording(obs: OBSWebSocket): Promise<string> {
    return new Promise(async resolve => {
        obs.on("RecordingStarted", ({recordingFilename}) => {
            obs.removeAllListeners("RecordingStarted")
            console.log(marked(`## 🔴 Recording...`))
            resolve(recordingFilename);
        })
        await new Promise(resolve => setTimeout(resolve, 500));
        await obs.send("StartRecording")
        //console.debug("Recording started")
    })
}

async function setFilename(obs: OBSWebSocket, filename: string) {
    await obs.send("SetFilenameFormatting", {"filename-formatting": filename})
}

async function readScriptContent(location: string, scriptFilename: string): Promise<TokensList> {
    return new Promise((resolve, reject) => {
        fs.readFile(path.join(location, scriptFilename), (err, markdownContent) => {
            if (err) {
                reject(err)
                return;
            }
            resolve(marked.lexer(markdownContent.toString()))
        })
    })
}

enum ACTIONS {
    RECORD = "Record",
    IGNORE = "Ignore",
    GOOD = "✔︎ Good (Save & continue)",
    RETAKE = "🗑 Retake (Delete take & start over)",
    SKIP = "~ Ignore (Delete & continue)",
}
