import * as marked from "marked";
import * as fs from "fs";
import * as path from "path";
import * as inquirer from "inquirer";
import OBSWebSocket from "obs-websocket-js";

const scriptsLocation = './scripts';
const scriptDir = fs.readdirSync(scriptsLocation);
const markdownFiles = scriptDir.filter(file => file.match(".*\\.md"));
const testFile = markdownFiles[0];
const markdownContent = fs.readFileSync(path.join(scriptsLocation, testFile)).toString();

const lexer = marked.lexer(markdownContent);

const scriptTitle = lexer[0].type === "heading" ? lexer[0].text : testFile;
const texts: marked.Tokens.Paragraph[] = lexer.filter((te) => te.type === "paragraph") as marked.Tokens.Paragraph[];

const prompt = inquirer.createPromptModule();

(async function () {
    const obs = new OBSWebSocket();
    await obs.connect({address: 'localhost:4444', password: ''});

    const response = await prompt({
        type: "confirm",
        message: "Ready to record: " + scriptTitle,
        name: "readyToRecord"
    });

    if (!response.readyToRecord) {
        return;
    }
    for (const text of texts) {
        const response = await prompt({
            type: "list", message: text.text, name: "textToRecord", choices: [
                "Start",
                "Skip"
            ]
        });

        switch (response.textToRecord) {
            case "Start":
                try {
                    do {
                        await obs.send("SetFilenameFormatting", {"filename-formatting": "adopt-2"})
                        const status = await obs.send("GetRecordingStatus");
                        if (status.isRecording) {
                            await obs.send("StopRecording")
                            await new Promise(resolve => setTimeout(resolve, 1500))
                        }
                        await obs.send("StartRecording")
                        console.log("🔴 Recording...")
                    } while ((await prompt({
                        name: "takeFeedback", message: "Take status", type: "list", choices: [
                            "✔︎ Good",
                            "🗑 Retake"
                        ]
                    })).takeFeedback !== "✔︎ Good")
                    await obs.send("StopRecording");
                    break;
                } catch (e) {
                    console.log(e);
                    throw e;
                }
        }
    }
})()

