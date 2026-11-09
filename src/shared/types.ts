export interface ApprovedScope {
    match: string[];
    include: string[];
    exclude: string[];
}
export interface Script {
    id: string;
    name: string;
    code: string;
    enabled?: boolean;
    lastSavedCode?: string;
    grantedPermissions?: string[];
    approvedScope?: ApprovedScope;
    pendingApproval?: boolean;
    sourceUrl?: string;
    referrerUrl?: string;
    namespace?: string;
    installDate?: number;
    updateDate?: number;
    folderPath?: string;
    filePath?: string;
    token?: string;
}
export type Theme = 'light' | 'dark' | 'system';
