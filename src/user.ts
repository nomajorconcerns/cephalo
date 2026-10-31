import os from "node:os";

/** The OS account running the agent (recorded in every audit entry). */
export function currentUser(): string | undefined {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USERNAME ?? process.env.USER;
  }
}
