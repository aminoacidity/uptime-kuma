const { MonitorType } = require("./monitor-type");
const { ImapFlow } = require("imapflow");
const net = require("net");
const tls = require("tls");
const { simpleParser } = require("mailparser");

/**
 * @type {number} UP status constant
 */
const UP = 1;

/**
 * IMAP / POP3 Monitor Type
 * Connects to email server, searches for specific emails, reports UP if found.
 * Supports IMAP, IMAPS, POP3, POP3S protocols.
 */
class ImapMonitorType extends MonitorType {
    name = "imap";

    /**
     * @inheritdoc
     */
    async check(monitor, heartbeat, _server) {
        const hostname = monitor.hostname;
        if (!hostname) {
            throw new Error("Hostname is required");
        }

        const protocol = monitor.imapProtocol || "imap";

        if (protocol === "imap" || protocol === "imaps") {
            await this.checkImap(monitor, heartbeat);
        } else if (protocol === "pop3" || protocol === "pop3s") {
            await this.checkPop3(monitor, heartbeat);
        } else {
            throw new Error(`Unknown protocol: ${protocol}`);
        }
    }

    /**
     * IMAP/IMAPS check using imapflow
     */
    async checkImap(monitor, heartbeat) {
        const startTime = Date.now();
        const isSecure = monitor.imapProtocol === "imaps";
        const port = monitor.port || (isSecure ? 993 : 143);
        const searchQuery = (monitor.imapSearchQuery || "").trim();
        const searchField = monitor.imapSearchField || "subject";
        const mailbox = monitor.imapMailbox || "INBOX";
        const deleteAfterCheck = monitor.imapDeleteAfterCheck;

        if (!searchQuery) {
            throw new Error("Search query is required");
        }

        const client = new ImapFlow({
            host: monitor.hostname,
            port: parseInt(port, 10),
            secure: isSecure,
            auth: {
                user: monitor.imapUsername,
                pass: monitor.imapPassword,
            },
            logger: false,
            tls: {
                rejectUnauthorized: !monitor.getIgnoreTls(),
            },
        });

        try {
            await client.connect();

            // Select mailbox
            await client.mailboxOpen(mailbox);

            // Build search criteria based on search field
            let searchCriteria;
            switch (searchField) {
                case "subject":
                    searchCriteria = { subject: searchQuery };
                    break;
                case "from":
                    searchCriteria = { from: searchQuery };
                    break;
                case "body":
                    searchCriteria = { body: searchQuery };
                    break;
                case "all":
                default:
                    // IMAP TEXT search covers subject + body
                    searchCriteria = { text: searchQuery };
                    break;
            }

            const matchingUids = await client.search(searchCriteria);
            const matchCount = matchingUids.length;

            if (matchCount > 0) {
                heartbeat.status = UP;
                heartbeat.msg = `Found ${matchCount} matching email(s)`;

                if (deleteAfterCheck) {
                    await client.messageDelete(matchingUids, { uid: true });
                }
            } else {
                throw new Error("No matching email found");
            }
        } finally {
            try {
                await client.logout();
            } catch {
                // Ignore logout errors
            }
        }

        heartbeat.ping = Date.now() - startTime;
    }

    /**
     * POP3/POP3S check using raw sockets
     */
    async checkPop3(monitor, heartbeat) {
        const startTime = Date.now();
        const isSecure = monitor.imapProtocol === "pop3s";
        const port = monitor.port || (isSecure ? 995 : 110);
        const searchQuery = (monitor.imapSearchQuery || "").trim();
        const searchField = monitor.imapSearchField || "subject";
        const deleteAfterCheck = monitor.imapDeleteAfterCheck;

        if (!searchQuery) {
            throw new Error("Search query is required");
        }

        let socket;
        const maxMessages = 50;

        try {
            // Connect
            if (isSecure) {
                socket = tls.connect({
                    host: monitor.hostname,
                    port: parseInt(port, 10),
                    rejectUnauthorized: !monitor.getIgnoreTls(),
                });
            } else {
                socket = net.createConnection({
                    host: monitor.hostname,
                    port: parseInt(port, 10),
                });
            }

            await this.pop3WaitForResponse(socket, "greeting");

            // Authenticate
            await this.pop3SendCommand(socket, `USER ${monitor.imapUsername}`);
            await this.pop3SendCommand(socket, `PASS ${monitor.imapPassword}`);

            // Get message count
            const statResponse = await this.pop3SendCommand(socket, "STAT");
            const statParts = statResponse.split(" ");
            const messageCount = parseInt(statParts[1], 10) || 0;

            if (messageCount === 0) {
                throw new Error("No messages in mailbox");
            }

            // Search recent messages (last N messages, bounded)
            const messagesToCheck = Math.min(messageCount, maxMessages);
            let matchFound = false;
            let matchedMsgNum = null;

            for (let i = 0; i < messagesToCheck; i++) {
                const msgNum = messageCount - i;
                // TOP <msgNum> 0 gets headers only
                const headerData = await this.pop3SendCommand(socket, `TOP ${msgNum} 0`, true);

                // Parse headers to check for match
                const parsed = await simpleParser(headerData, { skipBody: true });
                let match = false;

                switch (searchField) {
                    case "subject":
                        match = parsed.subject && parsed.subject.toLowerCase().includes(searchQuery.toLowerCase());
                        break;
                    case "from":
                        match = parsed.from && parsed.from.text && parsed.from.text.toLowerCase().includes(searchQuery.toLowerCase());
                        break;
                    case "body":
                        // For body matching in POP3, fetch full message
                        const fullData = await this.pop3SendCommand(socket, `RETR ${msgNum}`, true);
                        const fullParsed = await simpleParser(fullData);
                        match = fullParsed.text && fullParsed.text.toLowerCase().includes(searchQuery.toLowerCase());
                        break;
                    case "all":
                    default:
                        // Check subject + from + body
                        let allText = ((parsed.subject || "") + " " + (parsed.from?.text || "")).toLowerCase();
                        match = allText.includes(searchQuery.toLowerCase());
                        if (!match) {
                            // Also check body
                            const fullData2 = await this.pop3SendCommand(socket, `RETR ${msgNum}`, true);
                            const fullParsed2 = await simpleParser(fullData2);
                            if (fullParsed2.text) {
                                match = fullParsed2.text.toLowerCase().includes(searchQuery.toLowerCase());
                            }
                        }
                        break;
                }

                if (match) {
                    matchFound = true;
                    matchedMsgNum = msgNum;
                    break;
                }
            }

            if (matchFound) {
                heartbeat.status = UP;
                heartbeat.msg = "Found matching email(s)";

                if (deleteAfterCheck && matchedMsgNum) {
                    await this.pop3SendCommand(socket, `DELE ${matchedMsgNum}`);
                }
            } else {
                throw new Error("No matching email found");
            }
        } finally {
            try {
                await this.pop3SendCommand(socket, "QUIT");
            } catch {
                // Ignore quit errors
            }
            try {
                socket.destroy();
            } catch {
                // Ignore destroy errors
            }
        }

        heartbeat.ping = Date.now() - startTime;
    }

    /**
     * Send a POP3 command and wait for response
     * @param {net.Socket} socket
     * @param {string} command
     * @param {boolean} [multiline=false]
     * @returns {Promise<string>} Response data
     */
    pop3SendCommand(socket, command, multiline = false) {
        return new Promise((resolve, reject) => {
            const commandToSend = command + "\r\n";
            socket.write(commandToSend);

            const onData = (data) => {
                cleanup();
                const response = data.toString();

                if (response.startsWith("+OK")) {
                    if (multiline) {
                        // For multiline responses, collect until ".\r\n"
                        let allData = response;
                        const onMoreData = (moreData) => {
                            allData += moreData.toString();
                            if (allData.endsWith("\r\n.\r\n")) {
                                cleanup2();
                                resolve(allData);
                            }
                        };

                        const onError2 = (err) => {
                            cleanup2();
                            reject(err);
                        };

                        const cleanup2 = () => {
                            socket.removeListener("data", onMoreData);
                            socket.removeListener("error", onError2);
                        };

                        socket.on("data", onMoreData);
                        socket.once("error", onError2);

                        // Check if we already have the complete response
                        if (allData.endsWith("\r\n.\r\n")) {
                            cleanup2();
                            resolve(allData);
                        }
                    } else {
                        resolve(response);
                    }
                } else if (response.startsWith("-ERR")) {
                    // Check if it's an auth failure vs general error
                    if (command.startsWith("USER") || command.startsWith("PASS")) {
                        reject(new Error("POP3 authentication failed"));
                    } else {
                        reject(new Error(`POP3 error: ${response.trim()}`));
                    }
                } else {
                    reject(new Error(`Unexpected POP3 response: ${response.trim()}`));
                }
            };

            const onError = (err) => {
                cleanup();
                reject(err);
            };

            const cleanup = () => {
                socket.removeListener("data", onData);
                socket.removeListener("error", onError);
            };

            socket.once("data", onData);
            socket.once("error", onError);
        });
    }

    /**
     * Wait for initial POP3 greeting
     */
    pop3WaitForResponse(socket, label) {
        return new Promise((resolve, reject) => {
            const onData = (data) => {
                cleanup();
                const response = data.toString();
                if (response.startsWith("+OK")) {
                    resolve(response);
                } else {
                    reject(new Error(`POP3 ${label} failed: ${response.trim()}`));
                }
            };

            const onError = (err) => {
                cleanup();
                reject(err);
            };

            const cleanup = () => {
                socket.removeListener("data", onData);
                socket.removeListener("error", onError);
            };

            socket.once("data", onData);
            socket.once("error", onError);
        });
    }
}

module.exports = {
    ImapMonitorType,
};
