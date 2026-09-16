import { users, submissions, integrationRequests, questionnaireResponses, type User, type InsertUser, type Submission, type InsertSubmission, type IntegrationRequest, type InsertIntegrationRequest, type QuestionnaireResponse, type InsertQuestionnaireResponse } from "@shared/schema";

// Storage interface for the real estate services platform
export interface IStorage {
  // User operations
  getUser(id: number): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  getUserByEmail(email: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  
  // Submission operations
  createSubmission(submission: InsertSubmission): Promise<Submission>;
  getSubmission(id: number): Promise<Submission | undefined>;
  updateSubmissionStatus(id: number, status: string): Promise<Submission | undefined>;
  getSubmissionsByUserId(userId: number): Promise<Submission[]>;
  
  // Integration request operations
  createIntegrationRequest(request: InsertIntegrationRequest): Promise<IntegrationRequest>;
  getIntegrationRequest(id: number): Promise<IntegrationRequest | undefined>;
  updateIntegrationRequest(id: number, status: string, responseData: any): Promise<IntegrationRequest | undefined>;
  getIntegrationRequestsBySubmissionId(submissionId: number): Promise<IntegrationRequest[]>;
  
  // Questionnaire response operations
  getQuestionnaireResponse(sessionId: string, serviceType: string, stepName: string): Promise<QuestionnaireResponse | undefined>;
  updateQuestionnaireResponse(sessionId: string, serviceType: string, stepName: string, responseData: any, isCompleted?: boolean): Promise<QuestionnaireResponse | undefined>;
}

export class MemStorage implements IStorage {
  private users: Map<number, User>;
  private submissions: Map<number, Submission>;
  private integrationRequests: Map<number, IntegrationRequest>;
  private questionnaireResponses: Map<string, QuestionnaireResponse>;
  private userIdCounter: number;
  private submissionIdCounter: number;
  private integrationRequestIdCounter: number;
  private questionnaireResponseIdCounter: number;

  constructor() {
    this.users = new Map();
    this.submissions = new Map();
    this.integrationRequests = new Map();
    this.questionnaireResponses = new Map();
    this.userIdCounter = 1;
    this.submissionIdCounter = 1;
    this.integrationRequestIdCounter = 1;
    this.questionnaireResponseIdCounter = 1;
  }

  // User operations
  async getUser(id: number): Promise<User | undefined> {
    return this.users.get(id);
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    return Array.from(this.users.values()).find(
      (user) => user.username === username,
    );
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    return Array.from(this.users.values()).find(
      (user) => user.email === email,
    );
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const id = this.userIdCounter++;
    const createdAt = new Date();
    const user: User = {
      ...insertUser,
      id,
      createdAt,
      phone: insertUser.phone ?? null,
      contactPreference: insertUser.contactPreference ?? null,
    };
    this.users.set(id, user);
    return user;
  }

  // Submission operations
  async createSubmission(insertSubmission: InsertSubmission): Promise<Submission> {
    const id = this.submissionIdCounter++;
    const createdAt = new Date();
    const submission: Submission = {
      ...insertSubmission,
      id,
      createdAt,
      userId: insertSubmission.userId ?? null,
      status: insertSubmission.status ?? null,
      selectedServices: [...insertSubmission.selectedServices],
    };
    this.submissions.set(id, submission);
    return submission;
  }

  async getSubmission(id: number): Promise<Submission | undefined> {
    return this.submissions.get(id);
  }

  async updateSubmissionStatus(id: number, status: string): Promise<Submission | undefined> {
    const submission = this.submissions.get(id);
    if (!submission) return undefined;
    
    const updatedSubmission = { ...submission, status };
    this.submissions.set(id, updatedSubmission);
    return updatedSubmission;
  }

  async getSubmissionsByUserId(userId: number): Promise<Submission[]> {
    return Array.from(this.submissions.values()).filter(
      (submission) => submission.userId === userId,
    );
  }

  // Integration request operations
  async createIntegrationRequest(insertRequest: InsertIntegrationRequest): Promise<IntegrationRequest> {
    const id = this.integrationRequestIdCounter++;
    const createdAt = new Date();
    const request: IntegrationRequest = {
      ...insertRequest,
      id,
      createdAt,
      status: insertRequest.status ?? null,
      responseData: insertRequest.responseData ?? null,
    };
    this.integrationRequests.set(id, request);
    return request;
  }

  async getIntegrationRequest(id: number): Promise<IntegrationRequest | undefined> {
    return this.integrationRequests.get(id);
  }

  async updateIntegrationRequest(
    id: number, 
    status: string, 
    responseData: any
  ): Promise<IntegrationRequest | undefined> {
    const request = this.integrationRequests.get(id);
    if (!request) return undefined;
    
    const updatedRequest = { ...request, status, responseData };
    this.integrationRequests.set(id, updatedRequest);
    return updatedRequest;
  }

  async getIntegrationRequestsBySubmissionId(submissionId: number): Promise<IntegrationRequest[]> {
    return Array.from(this.integrationRequests.values()).filter(
      (request) => request.submissionId === submissionId,
    );
  }

  // Questionnaire response operations
  async getQuestionnaireResponse(sessionId: string, serviceType: string, stepName: string): Promise<QuestionnaireResponse | undefined> {
    const key = `${sessionId}-${serviceType}-${stepName}`;
    return this.questionnaireResponses.get(key);
  }

  async updateQuestionnaireResponse(
    sessionId: string, 
    serviceType: string, 
    stepName: string, 
    responseData: any, 
    isCompleted?: boolean
  ): Promise<QuestionnaireResponse | undefined> {
    const key = `${sessionId}-${serviceType}-${stepName}`;
    const existing = this.questionnaireResponses.get(key);
    if (!existing) return undefined;
    
    const updated = { 
      ...existing, 
      responseData, 
      isCompleted: isCompleted ?? existing.isCompleted,
      updatedAt: new Date()
    };
    this.questionnaireResponses.set(key, updated);
    return updated;
  }
}

// Use DatabaseStorage for persistent storage with PostgreSQL
import { eq, and } from "drizzle-orm";
import { db } from "./db";
import { supabaseAdmin } from "./supabase";
import {
  managedDataRouting,
  mirrorSourceResultOrWriteTarget,
  routedRead,
  routedWrite,
} from "./managed-data-routing";

export class DatabaseStorage implements IStorage {
  async getUser(id: number): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user || undefined;
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.username, username));
    return user || undefined;
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.email, email));
    return user || undefined;
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const [user] = await db
      .insert(users)
      .values(insertUser)
      .returning();
    return user;
  }
  
  async createSubmission(insertSubmission: InsertSubmission): Promise<Submission> {
    const [submission] = await db
      .insert(submissions)
      .values(insertSubmission as typeof submissions.$inferInsert)
      .returning();
    return submission;
  }

  async getSubmission(id: number): Promise<Submission | undefined> {
    const [submission] = await db.select().from(submissions).where(eq(submissions.id, id));
    return submission || undefined;
  }

  async updateSubmissionStatus(id: number, status: string): Promise<Submission | undefined> {
    const [submission] = await db
      .update(submissions)
      .set({ status })
      .where(eq(submissions.id, id))
      .returning();
    return submission || undefined;
  }

  async getSubmissionsByUserId(userId: number): Promise<Submission[]> {
    return await db.select().from(submissions).where(eq(submissions.userId, userId));
  }

  async createIntegrationRequest(request: InsertIntegrationRequest): Promise<IntegrationRequest> {
    const [integrationRequest] = await db
      .insert(integrationRequests)
      .values(request)
      .returning();
    return integrationRequest;
  }

  async getIntegrationRequest(id: number): Promise<IntegrationRequest | undefined> {
    const [request] = await db
      .select()
      .from(integrationRequests)
      .where(eq(integrationRequests.id, id));
    return request || undefined;
  }

  async updateIntegrationRequest(
    id: number, 
    status: string, 
    responseData: any
  ): Promise<IntegrationRequest | undefined> {
    const [request] = await db
      .update(integrationRequests)
      .set({ status, responseData })
      .where(eq(integrationRequests.id, id))
      .returning();
    return request || undefined;
  }

  async getIntegrationRequestsBySubmissionId(submissionId: number): Promise<IntegrationRequest[]> {
    return await db
      .select()
      .from(integrationRequests)
      .where(eq(integrationRequests.submissionId, submissionId));
  }

  // Questionnaire response operations
  async getQuestionnaireResponse(sessionId: string, serviceType: string, stepName: string): Promise<QuestionnaireResponse | undefined> {
    const [result] = await db
      .select()
      .from(questionnaireResponses)
      .where(
        and(
          eq(questionnaireResponses.sessionId, sessionId),
          eq(questionnaireResponses.serviceType, serviceType),
          eq(questionnaireResponses.stepName, stepName)
        )
      );
    return result;
  }

  async updateQuestionnaireResponse(sessionId: string, serviceType: string, stepName: string, responseData: any, isCompleted?: boolean): Promise<QuestionnaireResponse | undefined> {
    const [updated] = await db
      .update(questionnaireResponses)
      .set({
        responseData,
        isCompleted: isCompleted ?? false,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(questionnaireResponses.sessionId, sessionId),
          eq(questionnaireResponses.serviceType, serviceType),
          eq(questionnaireResponses.stepName, stepName)
        )
      )
      .returning();
    return updated;
  }
}

function fromTargetRow<T>(row: Record<string, any>): T {
  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(row)) {
    result[key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())] =
      /_(?:at)$/.test(key) && typeof value === "string" ? new Date(value) : value;
  }
  return result as T;
}

function toTargetRow(row: Record<string, any>): Record<string, any> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`),
    value instanceof Date ? value.toISOString() : value,
  ]));
}

class SupabaseStorage implements IStorage {
  private client() {
    if (!supabaseAdmin) throw new Error("Supabase admin client is unavailable");
    return supabaseAdmin;
  }
  private async one<T>(table: string, query: any): Promise<T | undefined> {
    const { data, error } = await query.limit(1);
    if (error) throw error;
    return data?.[0] ? fromTargetRow<T>(data[0]) : undefined;
  }
  private async insert<T>(table: string, value: Record<string, any>): Promise<T> {
    const { data, error } = await this.client().from(table).insert(toTargetRow(value)).select().single();
    if (error) throw error;
    return fromTargetRow<T>(data);
  }
  async mirror(table: string, value: Record<string, any>, conflict = "id"): Promise<void> {
    const { error } = await this.client().from(table).upsert(toTargetRow(value), { onConflict: conflict });
    if (error) throw error;
  }
  getUser(id: number) {
    return this.one<User>("managed_users", this.client().from("managed_users").select("*").eq("id", id));
  }
  getUserByUsername(username: string) {
    return this.one<User>("managed_users", this.client().from("managed_users").select("*").eq("username", username));
  }
  getUserByEmail(email: string) {
    return this.one<User>("managed_users", this.client().from("managed_users").select("*").eq("email", email));
  }
  createUser(value: InsertUser) { return this.insert<User>("managed_users", value); }
  createSubmission(value: InsertSubmission) { return this.insert<Submission>("managed_submissions", value); }
  getSubmission(id: number) {
    return this.one<Submission>("managed_submissions", this.client().from("managed_submissions").select("*").eq("id", id));
  }
  async updateSubmissionStatus(id: number, status: string) {
    return this.one<Submission>("managed_submissions", this.client().from("managed_submissions").update({ status }).eq("id", id).select());
  }
  async getSubmissionsByUserId(userId: number) {
    const { data, error } = await this.client().from("managed_submissions").select("*").eq("user_id", userId);
    if (error) throw error;
    return (data ?? []).map(row => fromTargetRow<Submission>(row));
  }
  createIntegrationRequest(value: InsertIntegrationRequest) {
    return this.insert<IntegrationRequest>("managed_integration_requests", value);
  }
  getIntegrationRequest(id: number) {
    return this.one<IntegrationRequest>("managed_integration_requests", this.client().from("managed_integration_requests").select("*").eq("id", id));
  }
  updateIntegrationRequest(id: number, status: string, responseData: any) {
    return this.one<IntegrationRequest>("managed_integration_requests", this.client().from("managed_integration_requests").update({ status, response_data: responseData }).eq("id", id).select());
  }
  async getIntegrationRequestsBySubmissionId(submissionId: number) {
    const { data, error } = await this.client().from("managed_integration_requests").select("*").eq("submission_id", submissionId);
    if (error) throw error;
    return (data ?? []).map(row => fromTargetRow<IntegrationRequest>(row));
  }
  getQuestionnaireResponse(sessionId: string, serviceType: string, stepName: string) {
    return this.one<QuestionnaireResponse>(
      "managed_questionnaire_responses",
      this.client().from("managed_questionnaire_responses").select("*")
        .eq("session_id", sessionId).eq("service_type", serviceType).eq("step_name", stepName),
    );
  }
  updateQuestionnaireResponse(sessionId: string, serviceType: string, stepName: string, responseData: any, isCompleted?: boolean) {
    const values: Record<string, any> = {
      response_data: responseData,
      is_completed: isCompleted ?? false,
      updated_at: new Date().toISOString(),
    };
    return this.one<QuestionnaireResponse>(
      "managed_questionnaire_responses",
      this.client().from("managed_questionnaire_responses").update(values)
        .eq("session_id", sessionId).eq("service_type", serviceType).eq("step_name", stepName).select(),
    );
  }
}

class RoutedStorage implements IStorage {
  constructor(private source = new DatabaseStorage(), private target = new SupabaseStorage()) {}
  private read<T>(source: () => Promise<T>, target: () => Promise<T>) {
    return routedRead(source, target, managedDataRouting);
  }
  private create<T extends Record<string, any>>(table: string, conflict: string, source: () => Promise<T>, target: () => Promise<T>) {
    return routedWrite(source, async (sourceRow, context) => {
      const result = await mirrorSourceResultOrWriteTarget(
        sourceRow,
        context,
        row => this.target.mirror(table, row, conflict),
        target,
      );
      if (!result) {
        throw new Error(`Managed ${table} create returned no row`);
      }
      return result;
    }, managedDataRouting);
  }
  getUser = (id: number) => this.read(() => this.source.getUser(id), () => this.target.getUser(id));
  getUserByUsername = (v: string) => this.read(() => this.source.getUserByUsername(v), () => this.target.getUserByUsername(v));
  getUserByEmail = (v: string) => this.read(() => this.source.getUserByEmail(v), () => this.target.getUserByEmail(v));
  createUser = (v: InsertUser) => this.create("managed_users", "id", () => this.source.createUser(v), () => this.target.createUser(v));
  createSubmission = (v: InsertSubmission) => this.create("managed_submissions", "id", () => this.source.createSubmission(v), () => this.target.createSubmission(v));
  getSubmission = (id: number) => this.read(() => this.source.getSubmission(id), () => this.target.getSubmission(id));
  updateSubmissionStatus = (id: number, v: string) => routedWrite(
    () => this.source.updateSubmissionStatus(id, v),
    (row, context) => mirrorSourceResultOrWriteTarget(
      row,
      context,
      sourceRow => this.target.mirror("managed_submissions", sourceRow),
      () => this.target.updateSubmissionStatus(id, v),
    ),
  );
  getSubmissionsByUserId = (id: number) => this.read(() => this.source.getSubmissionsByUserId(id), () => this.target.getSubmissionsByUserId(id));
  createIntegrationRequest = (v: InsertIntegrationRequest) => this.create("managed_integration_requests", "id", () => this.source.createIntegrationRequest(v), () => this.target.createIntegrationRequest(v));
  getIntegrationRequest = (id: number) => this.read(() => this.source.getIntegrationRequest(id), () => this.target.getIntegrationRequest(id));
  updateIntegrationRequest = (id: number, status: string, data: any) => routedWrite(
    () => this.source.updateIntegrationRequest(id, status, data),
    (row, context) => mirrorSourceResultOrWriteTarget(
      row,
      context,
      sourceRow => this.target.mirror("managed_integration_requests", sourceRow),
      () => this.target.updateIntegrationRequest(id, status, data),
    ),
  );
  getIntegrationRequestsBySubmissionId = (id: number) => this.read(() => this.source.getIntegrationRequestsBySubmissionId(id), () => this.target.getIntegrationRequestsBySubmissionId(id));
  getQuestionnaireResponse = (a: string, b: string, c: string) => this.read(() => this.source.getQuestionnaireResponse(a, b, c), () => this.target.getQuestionnaireResponse(a, b, c));
  updateQuestionnaireResponse = (a: string, b: string, c: string, data: any, done?: boolean) => routedWrite(
    () => this.source.updateQuestionnaireResponse(a, b, c, data, done),
    (row, context) => mirrorSourceResultOrWriteTarget(
      row,
      context,
      sourceRow => this.target.mirror("managed_questionnaire_responses", sourceRow),
      () => this.target.updateQuestionnaireResponse(a, b, c, data, done),
    ),
  );
}

export const storage = new RoutedStorage();
