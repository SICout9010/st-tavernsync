export {};

declare module '*.html' {
    const content: string;
    export default content;
}

declare module '*.css';

declare global {
    interface ToastrLike {
        info(message: string, title?: string, options?: object): unknown;
        success(message: string, title?: string, options?: object): unknown;
        warning(message: string, title?: string, options?: object): unknown;
        error(message: string, title?: string, options?: object): unknown;
    }

    interface LocalForageInstance {
        getItem<T>(key: string): Promise<T | null>;
        setItem<T>(key: string, value: T): Promise<T>;
        removeItem(key: string): Promise<void>;
        clear(): Promise<void>;
        keys(): Promise<string[]>;
    }

    interface LocalForageStatic {
        createInstance(options: { name: string; storeName: string }): LocalForageInstance;
    }

    interface SillyTavernLibs {
        localforage: LocalForageStatic;
    }

    interface SlashCommandNamedArgumentProps {
        name: string;
        description?: string;
        typeList?: string[];
        isRequired?: boolean;
        enumList?: string[];
        defaultValue?: string;
    }

    interface SlashCommandProps {
        name: string;
        aliases?: string[];
        callback: (namedArgs: Record<string, string>, unnamedArgs: string) => Promise<string> | string;
        helpString?: string;
        namedArgumentList?: unknown[];
        unnamedArgumentList?: unknown[];
    }

    interface SillyTavernContext {
        extensionSettings: Record<string, unknown>;
        saveSettingsDebounced: () => void;
        renderExtensionTemplateAsync: (
            extensionName: string,
            templateId: string,
            templateData?: object,
            sanitize?: boolean,
            localize?: boolean,
        ) => Promise<string>;
        getRequestHeaders: (options?: { omitContentType?: boolean }) => Record<string, string>;
        eventSource: {
            on: (event: string, callback: (...args: unknown[]) => void) => void;
            once?: (event: string, callback: (...args: unknown[]) => void) => void;
            off?: (event: string, callback: (...args: unknown[]) => void) => void;
        };
        event_types: Record<string, string> & {
            APP_READY?: string;
            CHAT_CHANGED?: string;
            SETTINGS_UPDATED?: string;
            GENERATION_STARTED?: string;
            GENERATION_ENDED?: string;
        };
        SlashCommandParser?: {
            addCommandObject: (command: unknown) => void;
        };
        SlashCommand?: {
            fromProps: (props: SlashCommandProps) => unknown;
        };
        SlashCommandNamedArgument?: {
            fromProps: (props: SlashCommandNamedArgumentProps) => unknown;
        };
        loader?: {
            show: (options: {
                blocking?: boolean;
                message?: string;
                title?: string;
                onStop?: () => void;
            }) => { hide: () => void };
        };
    }

    interface SillyTavernGlobal {
        getContext: () => SillyTavernContext;
        libs: SillyTavernLibs;
    }

    const toastr: ToastrLike;
    const SillyTavern: SillyTavernGlobal;
    // jQuery is provided by SillyTavern
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function jQuery(callback: () => void | Promise<void>): unknown;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const $: any;
}
