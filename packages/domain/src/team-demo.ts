export type TeamRole = "admin" | "member" | "auditor";
export type TeamUser = {
  id: string;
  username: string;
  displayName: string;
  role: TeamRole;
};
export type TeamTransfer = {
  id: string;
  sender: string;
  recipient: string;
  amount: string;
  createdAt: string;
};
export type TeamDashboard = {
  user: TeamUser;
  balance: string;
  canTransfer: boolean;
  recipients: TeamUser[];
  transfers: TeamTransfer[];
};
export type TeamAdmin = {
  users: (TeamUser & { balance: string; enabled: boolean })[];
  events: {
    id: number;
    actor: string | null;
    action: string;
    subject: string | null;
    createdAt: string;
  }[];
};
