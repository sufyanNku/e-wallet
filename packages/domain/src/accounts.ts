export type AccountRole = "admin" | "member" | "auditor";
export type AccountUser = {
  id: string;
  username: string;
  displayName: string;
  role: AccountRole;
};
export type AccountTransfer = {
  id: string;
  sender: string;
  recipient: string;
  amount: string;
  createdAt: string;
};
export type AccountDashboard = {
  user: AccountUser;
  balance: string;
  canTransfer: boolean;
  recipients: AccountUser[];
  transfers: AccountTransfer[];
};
export type AccountAdmin = {
  users: (AccountUser & { balance: string; enabled: boolean })[];
  events: {
    id: number;
    actor: string | null;
    action: string;
    subject: string | null;
    createdAt: string;
  }[];
};
