import fs from 'fs';
import { parentPort } from 'worker_threads';

import { LoginClient } from '#/server/login/LoginClient.js';
import Environment from '#/util/Environment.js';

import { type GenericLoginThreadResponse } from './index.d.js';
import { trackLoginAttempts, trackLoginTime } from './LoginMetrics.js';

const REVOLT_WHITELIST_PATH = 'data/revolt/revolt_whitelist_data.txt';
const WHITELIST_PATH = 'data/discordwhitelist.txt';
const whitelistSet = new Set<string>();

function normalize(name: string): string {
    return name.trim().toLowerCase().replace(/\s+/g, '_');
}

function loadWhitelist() {
    try {
        const basePath = 'data/whitelist.txt';
        let usernames: string[] = [];

        // Load Discord whitelist
        if (fs.existsSync(WHITELIST_PATH)) {
            const rawDiscord = fs.readFileSync(WHITELIST_PATH, 'utf-8');
            const discordNames = rawDiscord
                .split('\n')
                .map(line => line.split(',')[1])
                .filter(Boolean)
                .map(normalize);
            usernames = usernames.concat(discordNames);
        } else {
            console.error(`[Whitelist] Discord whitelist file not found: ${WHITELIST_PATH}`);
        }

        // Load Revolt whitelist
        if (fs.existsSync(REVOLT_WHITELIST_PATH)) {
            const rawRevolt = fs.readFileSync(REVOLT_WHITELIST_PATH, 'utf-8');
            const revoltNames = rawRevolt
                .split('\n')
                .map(line => line.split(',')[1])
                .filter(Boolean)
                .map(normalize);
            usernames = usernames.concat(revoltNames);
        } else {
            console.error(`[Whitelist] Revolt whitelist file not found: ${REVOLT_WHITELIST_PATH}`);
        }

        // Deduplicate and normalize usernames
        const unique = Array.from(new Set(usernames));

        // Write combined whitelist to whitelist.txt for other uses if needed
        fs.writeFileSync(basePath, unique.join('\n') + '\n');

        // Update the in-memory set
        whitelistSet.clear();
        for (const name of unique) {
            whitelistSet.add(name);
        }

        console.log(`[Whitelist] Reloaded ${whitelistSet.size} usernames from Discord + Revolt files.`);
    } catch (err) {
        console.error('[Whitelist] Failed to load:', err);
    }
}


loadWhitelist();
//setInterval(loadWhitelist, 30_000); // Optional: reload whitelist every 30s
fs.watchFile(WHITELIST_PATH, { interval: 1000 }, () => {
    console.log('[Whitelist] Discord whitelist file changed — reloading...');
    loadWhitelist();
});

fs.watchFile(REVOLT_WHITELIST_PATH, { interval: 1000 }, () => {
    console.log('[Whitelist] Revolt whitelist file changed — reloading...');
    loadWhitelist();
});



const loginQueue: { parentPort: ParentPort; msg: any }[] = [];
const MAX_CONCURRENT_LOGINS = 20;
let activeLogins = 0;

const client = new LoginClient(Environment.NODE_ID, whitelistSet);

if (!parentPort) 
{    
    throw new Error('This file must be run as a worker thread.');
}


parentPort.on('message', async msg => {
    try {
        await handleRequests(parentPort!, msg);
    } catch (err) {
        console.error(err);
    }
});

client.onMessage((opcode, data) => {
    parentPort!.postMessage({ opcode, data });
});

type ParentPort = {
    postMessage: (msg: GenericLoginThreadResponse) => void;
};

async function handleRequests(parentPort: ParentPort, msg: any) {
    const { type } = msg;

    switch (type) {
        case 'player_login': {
            loginQueue.push({ parentPort, msg });
            processLoginQueue();
            break;
        }
        case 'player_logout': {
            const { username, save } = msg;
            console.log(`[LOGOUT] ${username}`);

            if (Environment.LOGIN_SERVER) {
                const success = await client.playerLogout(username, save);
                parentPort.postMessage({ type: 'player_logout', username, success });
            } else {
                const profile = Environment.NODE_PROFILE;
                if (!fs.existsSync(`data/players/${profile}`)) {
                    fs.mkdirSync(`data/players/${profile}`, { recursive: true });
                }
                fs.writeFileSync(`data/players/${profile}/${username}.sav`, save);
                parentPort.postMessage({ type: 'player_logout', username, success: true });
            }
            break;
        }
        case 'player_autosave': {
            const { username, save } = msg;
            const profile = Environment.NODE_PROFILE;
            if (!fs.existsSync(`data/players/${profile}`)) {
                fs.mkdirSync(`data/players/${profile}`, { recursive: true });
            }
            fs.writeFileSync(`data/players/${profile}/${username}.sav`, save);
            break;
        }
        case 'player_force_logout': {
            if (Environment.LOGIN_SERVER) {
                const { username } = msg;
                await client.playerForceLogout(username);
            }
            break;
        }
        case 'player_ban': {
            if (Environment.LOGIN_SERVER) {
                const { staff, username, until } = msg;
                await client.playerBan(staff, username, until);
            }
            break;
        }
        case 'player_mute': {
            if (Environment.LOGIN_SERVER) {
                const { staff, username, until } = msg;
                await client.playerMute(staff, username, until);
            }
            break;
        }
        case 'world_startup': {
            if (Environment.LOGIN_SERVER) {
                await client.worldStartup();
            }
            break;
        }
        case 'world_heartbeat': {
            break;
        }
        default:
            console.error('Unknown message type: ' + msg.type);
            break;
    }
}

async function processLoginQueue() {
    while (activeLogins < MAX_CONCURRENT_LOGINS && loginQueue.length > 0) {
        const { parentPort, msg } = loginQueue.shift()!;
        const { socket, remoteAddress, username, password, uid, lowMemory, reconnecting, hasSave } = msg;

        if (!whitelistSet.has(username)) {
            console.log(`[Blocked] ${username} is not whitelisted`);
            await new Promise(res => setTimeout(res, 5000)); 
            console.log(`[Blocked] ${username} Login Delay Over`);
            parentPort.postMessage({
                type: 'player_login', socket, username, lowMemory, reconnecting,
                reply: 6, staffmodlevel: 0, save: null, account_id: 0,
                members: Environment.NODE_MEMBERS
            });
            continue;
        }

        activeLogins++;
        console.log(`[LOGIN QUEUE] Accepting ${username} (${activeLogins} active)`);

        (async () => {
            try {
                if (Environment.LOGIN_SERVER) {
                    trackLoginAttempts.inc();
                    const stopTimer = trackLoginTime.startTimer();
                    const response = await client.playerLogin(username, password, uid, socket, remoteAddress, reconnecting, hasSave);
                    await new Promise(res => setTimeout(res, 5000)); 
                    if (!Environment.NODE_PRODUCTION) response.staffmodlevel = 4;

                    parentPort.postMessage({
                        type: 'player_login', socket, username, lowMemory, reconnecting, ...response
                    });
                    stopTimer();
                } else {
                    const staffmodlevel = Environment.NODE_PRODUCTION ? 0 : 4;
                    const profile = Environment.NODE_PROFILE;
                    if (!fs.existsSync(`data/players/${profile}`)) {
                        fs.mkdirSync(`data/players/${profile}`, { recursive: true });
                    }
                    const path = `data/players/${profile}/${username}.sav`;
                    const hasSave = fs.existsSync(path);
                    const save = hasSave ? fs.readFileSync(path) : null;
                    const reply = hasSave ? 0 : 4;

                    parentPort.postMessage({
                        type: 'player_login', socket, username, lowMemory, reconnecting,
                        reply, staffmodlevel, save, account_id: 1,
                        members: Environment.NODE_MEMBERS
                    });
                }
            } catch (err) {
                console.error(`[Login Error] ${username}:`, err);
                parentPort.postMessage({
                    type: 'player_login', socket, username, lowMemory, reconnecting,
                    reply: 7, staffmodlevel: 0, save: null, account_id: 0,
                    members: Environment.NODE_MEMBERS
                });
            } finally {
                activeLogins--;
                setImmediate(processLoginQueue);
            }
        })();
    }
}