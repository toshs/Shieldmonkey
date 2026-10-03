export interface Script {
    id: string;
    name: string;
    code: string;
    enabled?: boolean;
    grantedPermissions?: string[];
    sourceUrl?: string;
    referrerUrl?: string;

    installDate?: number;
    updateDate?: number;
    folderPath?: string;
    filePath?: string;
    token?: string;
    [key: string]: unknown;
}
