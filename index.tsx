import "./style.css";

import { addChatBarButton, removeChatBarButton, ChatBarButton } from "@api/ChatButtons";
import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import { ChannelStore, GuildStore, Modal, openModal, React, RestAPI, UserStore, NavigationRouter, ChannelRouter, MessageActions, TextInput, Button, Timestamp } from "@webpack/common";

const SEARCH_ICON = () => (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
        <path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z" />
    </svg>
);


interface SearchHit {
    messageId: string;
    channelId: string;
    guildId: string | null;
    content: string;
    author: {
        id: string;
        username: string;
        globalName?: string;
        avatar?: string;
        discriminator?: string;
        bot?: boolean;
    };
    timestamp: string;
    channelName: string;
    guildName: string | null;
}

interface SearchResponse {
    total_results: number;
    messages: any[][];
    analytics_id: string;
}

interface GuildEntry {
    id: string;
    name: string;
    icon?: string;
    ownerId?: string;
}


const settings = definePluginSettings({
    maxResultsPerGuild: {
        type: OptionType.NUMBER,
        description: "Max results per server/DM (25 is Discord's max per page)",
        default: 25,
    },
    searchDMs: {
        type: OptionType.BOOLEAN,
        description: "Search in DMs and Group DMs",
        default: true,
    },
    blacklistedGuilds: {
        type: OptionType.STRING,
        description: "Server IDs to exclude (comma-separated)",
        default: "",
        multiline: true,
    },
    whitelistedGuilds: {
        type: OptionType.STRING,
        description: "Only search these server IDs (comma-separated). Leave empty to search all servers.",
        default: "",
        multiline: true,
    },
    shortcutKey: {
        type: OptionType.STRING,
        description: "Keyboard shortcut to open Global Search (e.g. Ctrl+Shift+G, Alt+G, etc.) (might restart to apply)",
        default: "Ctrl+Shift+G",
        placeholder: "Ctrl+Shift+G",
    },
    activationMode: {
        type: OptionType.SELECT,
        description: "How do you wanna open the search? (might restart to apply)",
        options: [
            { label: "Both (Keyboard + Chat Bar)", value: "both", default: true },
            { label: "Keyboard Shortcut only", value: "shortcut" },
            { label: "Chat Bar Button only", value: "button" },
        ],
    },
});


function getBlacklistedGuilds(): Set<string> {
    return new Set(settings.store.blacklistedGuilds.split(",").map(s => s.trim()).filter(Boolean));
}

function getWhitelistedGuilds(): Set<string> {
    const list = settings.store.whitelistedGuilds.split(",").map(s => s.trim()).filter(Boolean);
    return list.length > 0 ? new Set(list) : null as any;
}


function parseShortcut(shortcut: string): { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean; key: string; } | null {
    if (!shortcut || typeof shortcut !== "string") return null;

    const parts = shortcut.split("+").map(s => s.trim()).filter(Boolean);
    if (parts.length < 2) return null;

    const result: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean; key: string; } = { key: "" };
    const mods = new Set(parts.slice(0, -1).map(s => s.toLowerCase()));

    if (mods.has("ctrl")) result.ctrl = true;
    if (mods.has("shift")) result.shift = true;
    if (mods.has("alt")) result.alt = true;
    if (mods.has("meta") || mods.has("cmd") || mods.has("win")) result.meta = true;

    result.key = parts[parts.length - 1];

    if (!result.ctrl && !result.shift && !result.alt && !result.meta) return null;
    if (!result.key) return null;

    return result;
}


let _parsedShortcutCache: ReturnType<typeof parseShortcut> | null = null;
let _lastShortcutKey = "";

function matchesShortcut(e: KeyboardEvent): boolean {
    const currentKey = settings.store.shortcutKey;
    if (currentKey !== _lastShortcutKey) {
        _lastShortcutKey = currentKey;
        _parsedShortcutCache = parseShortcut(currentKey);
    }

    const s = _parsedShortcutCache;
    if (!s) return false;

    if (s.ctrl && !e.ctrlKey) return false;
    if (s.shift && !e.shiftKey) return false;
    if (s.alt && !e.altKey) return false;
    if (s.meta && !e.metaKey) return false;
    if (!s.ctrl && !s.shift && !s.alt && !s.meta) return false;

    const key = s.key.toLowerCase();
    if (key.length === 1) {
        return e.key.toLowerCase() === key;
    }
    return e.key === key;
}


async function searchGuild(guildId: string, query: string, maxResults: number): Promise<SearchHit[]> {
    try {
        const { body } = await RestAPI.get({
            url: `/guilds/${guildId}/messages/search`,
            query: {
                content: query,
                include_nsfw: true,
                limit: Math.min(maxResults, 25),
            },
        });

        return parseSearchResponse(body, guildId);
    } catch (e) {
        console.error(`[GlobalSearch] Failed to search guild ${guildId}:`, e);
        return [];
    }
}

async function searchDMChannel(channelId: string, query: string, maxResults: number): Promise<SearchHit[]> {
    try {
        const { body } = await RestAPI.get({
            url: `/channels/${channelId}/messages/search`,
            query: {
                content: query,
                limit: Math.min(maxResults, 25),
            },
        });

        return parseSearchResponse(body, null);
    } catch (e) {
        console.error(`[GlobalSearch] Failed to search DM ${channelId}:`, e);
        return [];
    }
}

function parseSearchResponse(body: SearchResponse, guildId: string | null): SearchHit[] {
    if (!body?.messages) return [];

    const hits: SearchHit[] = [];
    const guild = guildId ? GuildStore.getGuild(guildId) : null;

    for (const group of body.messages) {
        if (!group || group.length === 0) continue;
        const msg = group[0];
        if (!msg || !msg.id) continue;

        const author = UserStore.getUser(msg.author?.id);
        const channel = ChannelStore.getChannel(msg.channel_id);

        hits.push({
            messageId: msg.id,
            channelId: msg.channel_id,
            guildId,
            content: msg.content || "",
            author: {
                id: msg.author?.id || "unknown",
                username: author?.username || msg.author?.username || "Unknown",
                globalName: author?.globalName || msg.author?.globalName,
                avatar: msg.author?.avatar,
                discriminator: msg.author?.discriminator,
                bot: msg.author?.bot,
            },
            timestamp: msg.timestamp,
            channelName: channel?.name || msg.channel_id,
            guildName: guild?.name || null,
        });
    }

    return hits;
}


function openSearchModal() {
    openModal(props => <GlobalSearchModal modalProps={props} />);
}


function SVGSpinner() {
    return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ animation: "vc-gs-spin 0.8s linear infinite" }}>
            <circle cx="12" cy="12" r="10" stroke="var(--brand-experiment)" strokeWidth="3" strokeDasharray="31.4 31.4" strokeLinecap="round" />
        </svg>
    );
}


function GlobalSearchModal({ modalProps }: { modalProps: any }) {
    const [query, setQuery] = React.useState("");
    const [results, setResults] = React.useState<SearchHit[]>([]);
    const [isSearching, setIsSearching] = React.useState(false);
    const [hasSearched, setHasSearched] = React.useState(false);
    const [progress, setProgress] = React.useState({ current: 0, total: 0 });
    const [searchType, setSearchType] = React.useState<"all" | "guilds" | "dms">("all");
    const searchCanceled = React.useRef(false);


    const handleSearch = async () => {
        if (!query.trim()) return;

        searchCanceled.current = false;
        setIsSearching(true);
        setHasSearched(true);
        setResults([]);

        const maxResults = settings.store.maxResultsPerGuild;
        const allResults: SearchHit[] = [];
        const blacklisted = getBlacklistedGuilds();
        const whitelisted = getWhitelistedGuilds();

        const guilds = GuildStore.getGuilds();
        const guildIds = Object.keys(guilds).filter(id => {
            if (blacklisted.has(id)) return false;
            if (whitelisted && !whitelisted.has(id)) return false;
            return true;
        });

        const searchDMs = settings.store.searchDMs && searchType !== "guilds";
        const searchGuildsEnabled = searchType !== "dms";

        const channelsToSearch: Array<{ type: "guild"; guildId: string; } | { type: "dm"; channelId: string; }> = [];

        if (searchGuildsEnabled) {
            for (const guildId of guildIds) {
                channelsToSearch.push({ type: "guild", guildId });
            }
        }

        if (searchDMs) {
            const dmChannels = ChannelStore.getSortedPrivateChannels();
            for (const ch of dmChannels) {
                if (ch?.id) {
                    channelsToSearch.push({ type: "dm", channelId: ch.id });
                }
            }
        }

        setProgress({ current: 0, total: channelsToSearch.length });

        const batchSize = 5;
        for (let i = 0; i < channelsToSearch.length; i += batchSize) {
            if (searchCanceled.current) break;

            const batch = channelsToSearch.slice(i, i + batchSize);
            const batchResults = await Promise.all(
                batch.map(async (item) => {
                    if (searchCanceled.current) return [] as SearchHit[];
                    if (item.type === "guild") {
                        return searchGuild(item.guildId, query, maxResults);
                    } else {
                        return searchDMChannel(item.channelId, query, maxResults);
                    }
                })
            );

            for (const hits of batchResults) {
                allResults.push(...hits);
            }

            setResults([...allResults]);
            setProgress({
                current: Math.min(i + batchSize, channelsToSearch.length),
                total: channelsToSearch.length,
            });
        }

        allResults.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
        setResults(allResults);
        setIsSearching(false);
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === "Enter" && !isSearching) {
            handleSearch();
        }
    };


    const navigateToMessage = (hit: SearchHit) => {
        modalProps.onClose();

        if (hit.guildId) {
            NavigationRouter.transitionToGuild(hit.guildId);
        }

        setTimeout(() => {
            ChannelRouter.transitionToChannel(hit.channelId);
            setTimeout(() => {
                MessageActions.jumpToMessage({
                    channelId: hit.channelId,
                    messageId: hit.messageId,
                    flash: true,
                    jumpType: "INSTANT",
                });
            }, 400);
        }, hit.guildId ? 400 : 0);
    };

    const handleCancel = () => {
        searchCanceled.current = true;
        setIsSearching(false);
    };

    const guilds = GuildStore.getGuilds();
    const guildList = Object.values(guilds) as GuildEntry[];

    const filteredGuildCount = guildList.filter(g => {
        const blacklisted = getBlacklistedGuilds();
        const whitelisted = getWhitelistedGuilds();
        if (blacklisted.has(g.id)) return false;
        if (whitelisted && !whitelisted.has(g.id)) return false;
        return true;
    }).length;

    const shortcutDisplay = settings.store.shortcutKey;

    return (
        <Modal
            {...modalProps}
            size="lg"
            title="Global Search"
        >
            <div style={{ padding: "16px", display: "flex", flexDirection: "column", gap: "12px" }}>
                <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                    <div style={{ flex: 1, position: "relative" }}>
                        <TextInput
                            value={query}
                            onChange={setQuery}
                            placeholder={`Search across all servers and DMs... (${shortcutDisplay})`}
                            onKeyDown={handleKeyDown}
                            autoFocus
                        />
                    </div>
                    {isSearching ? (
                        <Button
                            onClick={handleCancel}
                            color={Button.Colors.RED}
                            size={Button.Sizes.SMALL}
                        >
                            Cancel
                        </Button>
                    ) : (
                        <Button
                            onClick={handleSearch}
                            disabled={!query.trim() || isSearching}
                            size={Button.Sizes.SMALL}
                        >
                            Search
                        </Button>
                    )}
                </div>

                <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                    <span style={{ color: "var(--text-muted)", fontSize: "12px", fontWeight: 600 }}>
                        Search in:
                    </span>
                    {(["all", "guilds", "dms"] as const).map(type => (
                        <Button
                            key={type}
                            look={searchType === type ? Button.Looks.FILLED : Button.Looks.LINK}
                            size={Button.Sizes.SMALL}
                            color={searchType === type ? Button.Colors.BRAND : Button.Colors.PRIMARY}
                            onClick={() => setSearchType(type)}
                        >
                            {type === "all" ? "All" : type === "guilds" ? `Servers (${filteredGuildCount})` : "DMs"}
                        </Button>
                    ))}
                </div>

                {isSearching && (
                    <div style={{ display: "flex", alignItems: "center", gap: "8px", color: "var(--text-muted)", fontSize: "13px" }}>
                        <SVGSpinner />
                        <span>
                            Searching... {progress.current}/{progress.total} locations
                        </span>
                    </div>
                )}

                <div style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "4px",
                    maxHeight: "500px",
                    overflowY: "auto",
                    borderTop: "1px solid var(--background-modifier-accent)",
                    paddingTop: "8px",
                }}>
                    {!isSearching && hasSearched && results.length === 0 && query && (
                        <div style={{ padding: "40px", textAlign: "center", color: "var(--text-muted)" }}>
                            No results found for "{query}"
                        </div>
                    )}

                    {results.map((hit, idx) => (
                        <div
                            key={`${hit.channelId}-${hit.messageId}-${idx}`}
                            onClick={() => navigateToMessage(hit)}
                            style={{
                                padding: "10px 12px",
                                borderRadius: "8px",
                                cursor: "pointer",
                                background: "var(--background-secondary-alt)",
                                transition: "background 0.15s ease",
                            }}
                            className="vc-global-search-result"
                        >
                            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
                                {hit.guildName ? (
                                    <span style={{
                                        fontSize: "10px",
                                        fontWeight: 700,
                                        color: "var(--text-muted)",
                                        background: "var(--background-tertiary)",
                                        padding: "2px 6px",
                                        borderRadius: "4px",
                                        textTransform: "uppercase",
                                        letterSpacing: "0.5px",
                                    }}>
                                        {hit.guildName}
                                    </span>
                                ) : (
                                    <span style={{
                                        fontSize: "10px",
                                        fontWeight: 700,
                                        color: "var(--text-muted)",
                                        background: "var(--background-tertiary)",
                                        padding: "2px 6px",
                                        borderRadius: "4px",
                                    }}>
                                        DM
                                    </span>
                                )}
                                <span style={{
                                    fontSize: "11px",
                                    color: "var(--text-muted)",
                                    fontWeight: 500,
                                }}>
                                    #{hit.channelName}
                                </span>
                                <span style={{
                                    fontSize: "11px",
                                    color: "var(--text-muted)",
                                    marginLeft: "auto",
                                }}>
                                    {hit.author.username}
                                </span>
                                {hit.author.bot && (
                                    <span style={{
                                        fontSize: "9px",
                                        color: "var(--text-link)",
                                        background: "var(--background-tertiary)",
                                        padding: "1px 4px",
                                        borderRadius: "3px",
                                        fontWeight: 700,
                                    }}>
                                        BOT
                                    </span>
                                )}
                            </div>

                            <div style={{
                                fontSize: "13px",
                                color: "var(--text-normal)",
                                lineHeight: "1.3",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                display: "-webkit-box",
                                WebkitLineClamp: 2,
                                WebkitBoxOrient: "vertical",
                                maxHeight: "2.6em",
                            }}>
                                {hit.content}
                            </div>

                            <div style={{
                                fontSize: "10px",
                                color: "var(--text-muted)",
                                marginTop: "2px",
                            }}>
                                <Timestamp timestamp={new Date(hit.timestamp)} />
                            </div>
                        </div>
                    ))}
                </div>

                {!isSearching && results.length > 0 && (
                    <div style={{ color: "var(--text-muted)", fontSize: "12px", textAlign: "center" }}>
                        Found {results.length} result{results.length !== 1 ? "s" : ""}
                    </div>
                )}
            </div>
        </Modal>
    );
}


export default definePlugin({
    name: "GlobalSearch",
    description:
        "Search for messages across all servers and DMs at once using Discord's search engine. " +
        "Customizable shortcut, chat bar button, or floating button. Ctrl+Shift+G to open.",
    authors: [
        { name: "SAMURAI", id: 1400403728552431698n }
    ],
    settings,

    start() {
        const mode = settings.store.activationMode;

        if (mode === "both" || mode === "button") {
            addChatBarButton("global-search", () => (
                <ChatBarButton
                    tooltip={`Global Search (${settings.store.shortcutKey})`}
                    onClick={openSearchModal}
                >
                    <SEARCH_ICON />
                </ChatBarButton>
            ), SEARCH_ICON);
        }

        if (mode === "both" || mode === "shortcut") {
            this._keydownHandler = (e: KeyboardEvent) => {
                if (matchesShortcut(e)) {
                    e.preventDefault();
                    e.stopPropagation();
                    openSearchModal();
                }
            };
            document.addEventListener("keydown", this._keydownHandler);
        }


    },

    stop() {
        removeChatBarButton("global-search");

        if (this._keydownHandler) {
            document.removeEventListener("keydown", this._keydownHandler);
            this._keydownHandler = null;
        }


    },

    _keydownHandler: null as ((e: KeyboardEvent) => void) | null,});
