---
"akeru-bot": patch
---

Bots connected to Slack, Discord, Telegram, WhatsApp, or iMessage now see where links point, even when a link shows a shortened label. Images and files shared in a channel message now reach the bot like composer attachments, and a message with only an image now gets a reply. Files the bot can't receive (an unsupported type, over 10 MB, or more than 8 in one message) are named to the bot with the reason. Slack apps need the `files:read` scope to share files.
