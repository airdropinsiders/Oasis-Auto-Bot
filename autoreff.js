import Mailjs from "@cemalgnlts/mailjs";
import axios from "axios";
import fs from 'fs';
import { HttpsProxyAgent } from 'https-proxy-agent';
import readline from "readline/promises";
import { delay } from "./utils/file.js";
import { logger } from "./utils/logger.js";
import { showBanner } from "./utils/banner.js";


const mailjs = new Mailjs();

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
});

function extractCodeFromEmail(text) {
    const regex = /code=([A-Za-z0-9]+)/;
    const match = text.match(regex);
    return match ? match[1] : null;
}

function readProxies(filePath) {
    return new Promise((resolve, reject) => {
        fs.readFile(filePath, 'utf8', (err, data) => {
        if (err) return reject(err);
        const proxies = data.split('\n').map(proxy => proxy.trim()).filter(proxy => proxy);
        resolve(proxies);
        });
    });
}

async function verifyEmail(code, proxy) {
    const proxyAgent = new HttpsProxyAgent(proxy);
    const url = "https://api.oasis.ai/internal/authVerifyEmail?batch=1";
    const payload = {
        "0": {
            json: {
                token: code,
            },
        },
    };

    try {
        const response = await axios.post(url, payload, {
            headers: { "Content-Type": "application/json" },
            httpsAgent: proxyAgent,
        });
        return response.data[0].result.data;
    } catch (error) {
        logger(
            "Error verifying email:",
            error.response ? error.response.data : error.message,
            'error'
        );
        return null;
    }
}

// Check for new emails 
async function checkForNewEmails(proxy) {
    try {
        const emailData = await mailjs.getMessages();
        const latestEmail = emailData.data[0];

        if (latestEmail) {
            logger("Received new Email:", latestEmail.subject);
            const msgId = latestEmail.id;

            const emailMessage = await mailjs.getMessage(msgId);
            const textContent = emailMessage.data.text;

            if (textContent) {
                const verificationCode = extractCodeFromEmail(textContent);
                if (verificationCode) {
                    const verifyResult = await verifyEmail(verificationCode, proxy);
                    if (verifyResult) {
                        logger("Email successfully verified:", verifyResult.json.message, 'success');
                        return true; 
                    } else {
                        await verifyEmail(verificationCode, proxy);
                    }
                }
            } else {
                logger("No text content in the email.", '', 'error');
            }

            await mailjs.deleteMessage(msgId);
        }
        return false;
    } catch (error) {
        logger("Error checking new emails:", error, 'error');
        return false;
    }
}

// Send signup request
async function sendSignupRequest(email, password, proxy, referralCode) {
    const proxyAgent = new HttpsProxyAgent(proxy);
    const url = "https://api.oasis.ai/internal/authSignup?batch=1";
    const payload = {
        "0": {
            json: {
                email,
                password,
                referralCode,
            },
        },
    };

    try {
        const response = await axios.post(url, payload, {
            headers: { "Content-Type": "application/json" },
            httpsAgent: proxyAgent,
        });
        logger(`Signup successful for`, email, 'success');
        return { email, status: "success", data: response.data };
    } catch (error) {
        const errorMessage = error.response
            ? error.response.statusText
            : error.message;
        logger(`Error during signup for ${email}:`, errorMessage, 'error');
        return null;
    }
}

async function saveAccountToFile(email, password) {
    const account = `${email}|${password}\n`; 
    fs.appendFileSync("accountsReff.txt", account, (err) => {
        if (err) {
            logger("Error saving account:", err, 'error');
        } else {
            logger("Account saved successfully to accounts.txt.");
        }
    });
}

// Main process 
async function main() {
    try {
        showBanner()
        const proxies = await readProxies('proxy.txt');
        if (proxies.length === 0) {
            throw new Error('No proxies available in proxy.txt');
        }
        const referralCode = await rl.question("Enter Your Referral code: ");
        const numAccounts = await rl.question("How many accounts do you want to create: ");
        const totalAccounts = parseInt(numAccounts);
        if (isNaN(totalAccounts) || totalAccounts <= 0) {
            logger("Please enter a valid number of accounts.", '', 'warn');
            return;
        }

        for (let i = 1; i <= totalAccounts; i++) {
            const proxy = proxies[i % proxies.length];
            logger(`Creating account ${i} of ${totalAccounts}...`);

            try {
                const account = await mailjs.createOneAccount();

                if (!account.status || !account.data) {
                    logger(`Error creating account ${i}:`, account.error || "Rate Limited, Recreating in 5 second...", 'error');
                    i--; 
                    await delay(5000);
                    continue;
                }

                const username = account.data.username;
                const password = account.data.password;
                logger(`Account ${i} created:`, username);

                mailjs.on("open", () => logger(`Awaiting verification email for account ${i}...`));
                
                let isSignup = await sendSignupRequest(username, password, proxy, referralCode);
                while (!isSignup) {
                    isSignup = await sendSignupRequest(username, password, proxy, referralCode);
                    await delay(5000);
                }

                let isEmailVerified = false;
                while (!isEmailVerified) {
                    isEmailVerified = await checkForNewEmails(proxy);
                    if (!isEmailVerified) {
                        await delay(5000); 
                    }
                }

                mailjs.on("arrive", () => onNewMessageReceived(i, username, password, proxy));
                await delay(10000);
            } catch (error) {
                logger(`Error during account creation ${i}:`, error, 'error');
            }
        }

        rl.close();
    } catch (error) {
        logger("Error:", error.message || error, 'error');
        rl.close();
    }
}

async function onNewMessageReceived(i, username, password, proxy) {
    try {
        logger(`New message received for account ${i}. Processing...`);
        await checkForNewEmails(proxy);

        mailjs.off();
        saveAccountToFile(username, password);
    } catch (error) {
        logger("Error processing new message:", error, 'error');
    }
}

main();
