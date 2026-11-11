const HOST_LINE_RE = /^(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?:\/[^\s]*)?$/i;

function truncateText(raw, maxChars) {
    if (!raw || typeof raw !== 'string')
        return '';
    const text = raw.trim();
    if (!text)
        return '';
    if (text.length <= maxChars)
        return text;
    return `${text.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

function shortenBrowserName(source) {
    if (!source)
        return '';
    const lower = source.toLowerCase();
    if (lower.includes('google chrome'))
        return 'Chrome';
    if (lower.includes('chromium'))
        return 'Chromium';
    if (lower.includes('brave'))
        return 'Brave';
    if (lower.includes('microsoft edge'))
        return 'Edge';
    if (lower.includes('firefox'))
        return 'Firefox';
    if (lower.includes('vivaldi'))
        return 'Vivaldi';
    if (lower.includes('opera'))
        return 'Opera';
    return source;
}

/**
 * Normalizes desktop & web push notifications (Chrome/WhatsApp Web, Slack, etc.)
 * so domain prefixes like "web.whatsapp.com\n\n1 new message" move neatly into
 * the metadata header instead of cluttering the message body.
 */
export function formatNotificationContent({
    title = '',
    body = '',
    sourceTitle = '',
    kind = 'notification',
    maxTitleChars = 130,
    maxBodyChars = 380,
    maxSourceChars = 48,
} = {}) {
    const cleanSource = truncateText(
        String(sourceTitle || '').replace(/\s+/g, ' '),
        maxSourceChars
    );
    const cleanTitle = truncateText(
        String(title || '').replace(/\r\n/g, '\n').replace(/\n+/g, ' '),
        maxTitleChars
    ) || 'Notification';

    const rawLines = String(body || '')
        .replace(/\r\n/g, '\n')
        .split('\n')
        .map(line => line.trimEnd());
    while (rawLines.length > 0 && rawLines[0].trim() === '')
        rawLines.shift();

    let originHost = '';
    const filteredLines = [];

    for (let i = 0; i < rawLines.length; i++) {
        const trimmed = rawLines[i].trim();
        if (filteredLines.length === 0 && !originHost && i === 0 && trimmed) {
            const match = trimmed.match(HOST_LINE_RE);
            const hasMoreContent = rawLines.slice(i + 1).some(l => l.trim().length > 0);
            if (match && hasMoreContent && (kind === 'notification' || kind === 'banner')) {
                originHost = match[1].toLowerCase();
                continue;
            }
            if (trimmed.toLowerCase() === cleanTitle.toLowerCase() && hasMoreContent)
                continue;
        }
        if (trimmed === '' && filteredLines[filteredLines.length - 1] === '')
            continue;
        filteredLines.push(trimmed);
    }

    while (filteredLines.length > 0 && filteredLines[0] === '')
        filteredLines.shift();
    while (filteredLines.length > 0 && filteredLines[filteredLines.length - 1] === '')
        filteredLines.pop();

    const normalizedBody = truncateText(filteredLines.join('\n'), maxBodyChars);

    let metaLabel = '';
    if (originHost) {
        const shortSrc = shortenBrowserName(cleanSource);
        if (shortSrc &&
            shortSrc.toLowerCase() !== originHost &&
            !shortSrc.toLowerCase().includes(originHost) &&
            shortSrc.toLowerCase() !== 'notification')
            metaLabel = `${originHost} • ${shortSrc}`;
        else
            metaLabel = originHost;
    } else if (cleanSource &&
        cleanSource.toLowerCase() !== cleanTitle.toLowerCase() &&
        !cleanTitle.toLowerCase().includes(cleanSource.toLowerCase())) {
        metaLabel = cleanSource;
    }

    return {
        title: cleanTitle,
        body: normalizedBody,
        metaLabel: truncateText(metaLabel, maxSourceChars),
        originHost,
        rawSource: cleanSource,
    };
}
