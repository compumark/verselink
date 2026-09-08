import { createHmac, randomBytes } from "node:crypto";

export const recoveryTokenPattern = /^vlr_[A-Za-z0-9_-]{43,64}$/;

export const generateRecoveryToken = () => `vlr_${randomBytes(32).toString("base64url")}`;

export const isRecoveryToken = (token) => recoveryTokenPattern.test(String(token || ""));

export const hashRecoveryToken = (token, pepper) => createHmac("sha256", pepper).update(`verselink-recovery:${token}`).digest("hex");
