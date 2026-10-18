"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";

const BASE_URL = process.env.NEXT_PUBLIC_API_URL;

// ─── Interfaces ──────────────────────────────────────────────────────────────

export interface Image {
    id: number;
    student_id: string | number;
    url: string;
    timestamp: string;
    metadata: Record<string, unknown>;
    event_id?: string;
    [key: string]: unknown;
}

export interface CreateImagePayload {
    student_id: string | number;
    url?: string;
    timestamp?: string;
    metadata?: Record<string, unknown>;
    event_id?: string;
    fileData?: string;
    month?: string;
}

export interface UpdateImagePayload {
    student_id?: string | number;
    url?: string;
    timestamp?: string;
    metadata?: Record<string, unknown>;
    event_id?: string;
    fileData?: string;
    month?: string;
}

export interface ImageRangeParams {
    start: string; // YYYY-MM-DD
    end: string;   // YYYY-MM-DD
}

export interface PaginatedImages {
    images: Image[];
    total: number;
    page: number;
    pageSize: number;
}

export interface ApiResponse<T> {
    status: string;
    data: T;
    message?: string;
}

// ─── Helper ───────────────────────────────────────────────────────────────────

async function getAuthHeaders(isFormData = false): Promise<HeadersInit> {
    const cookieStore = await cookies();
    const token = cookieStore.get("accessToken")?.value;
    const headers: Record<string, string> = {
        "Authorization": `Bearer ${token}`,
    };
    if (!isFormData) {
        headers["Content-Type"] = "application/json";
    }
    return headers;
}

// ─── Service Functions ────────────────────────────────────────────────────────

/** GET /images — Fetch all images. Supports pagination. */
export async function getAllImages(page?: number, pageSize?: number, search?: string): Promise<ApiResponse<PaginatedImages | Image[]>> {
    const headers = await getAuthHeaders();
    try {
        let url = `${BASE_URL}/images`;
        const params = new URLSearchParams();
        if (page !== undefined) params.set('page', String(page));
        if (pageSize !== undefined) params.set('pageSize', String(pageSize));
        if (search) params.set('search', search);
        const qs = params.toString();
        if (qs) url += `?${qs}`;
        const res = await fetch(url, { method: "GET", headers, cache: "no-store" });
        if (!res.ok) throw new Error(`Failed to fetch images: ${res.status} ${res.statusText}`);
        return res.json();
    } catch (error) {
        console.error("[getAllImages]", error);
        throw error;
    }
}

/** GET /images/:id — Fetch a single image by ID. */
export async function getImageById(id: number): Promise<ApiResponse<Image>> {
    const headers = await getAuthHeaders();
    try {
        const res = await fetch(`${BASE_URL}/images/${id}`, { method: "GET", headers, cache: "no-store" });
        if (!res.ok) throw new Error(`Failed to fetch image ${id}: ${res.status} ${res.statusText}`);
        return res.json();
    } catch (error) {
        console.error("[getImageById]", error);
        throw error;
    }
}

export interface ImageAccessUrl {
    id: number;
    url: string;
    expiresAt: string | null;
    expiresIn: number | null;
}

/** GET /images/:id/url — Fetch a short-lived authorized access URL for an image. */
export async function getImageUrl(id: number, duration?: number): Promise<ApiResponse<ImageAccessUrl>> {
    const headers = await getAuthHeaders();
    try {
        let url = `${BASE_URL}/images/${id}/url`;
        if (duration) {
            url += `?duration=${duration}`;
        }
        const res = await fetch(url, { method: "GET", headers, cache: "no-store" });
        if (!res.ok) throw new Error(`Failed to fetch image access URL for image ${id}: ${res.status} ${res.statusText}`);
        return res.json();
    } catch (error) {
        console.error("[getImageUrl]", error);
        throw error;
    }
}

/** GET /images/student/:studentId — Fetch all images for a specific student. */
export async function getImagesByStudent(studentId: string | number): Promise<ApiResponse<Image[]>> {
    const headers = await getAuthHeaders();
    try {
        const res = await fetch(`${BASE_URL}/images/student/${studentId}`, { method: "GET", headers, cache: "no-store" });
        if (!res.ok) throw new Error(`Failed to fetch images for student ${studentId}: ${res.status} ${res.statusText}`);
        return res.json();
    } catch (error) {
        console.error("[getImagesByStudent]", error);
        throw error;
    }
}

/** GET /images/range?start=&end= — Fetch images within a date range. */
export async function getImagesByRange(params: ImageRangeParams): Promise<ApiResponse<Image[]>> {
    const headers = await getAuthHeaders();
    try {
        const query = new URLSearchParams({ start: params.start, end: params.end });
        const res = await fetch(`${BASE_URL}/images/range?${query.toString()}`, { method: "GET", headers, cache: "no-store" });
        if (!res.ok) throw new Error(`Failed to fetch images by range: ${res.status} ${res.statusText}`);
        return res.json();
    } catch (error) {
        console.error("[getImagesByRange]", error);
        throw error;
    }
}

/** POST /images — Create a new image record via JSON or multipart FormData. */
export async function createImage(payload: CreateImagePayload | FormData): Promise<ApiResponse<Image>> {
    const isFormData = typeof FormData !== "undefined" && payload instanceof FormData;
    const headers = await getAuthHeaders(isFormData);
    try {
        const body = isFormData ? payload : JSON.stringify(payload);
        const res = await fetch(`${BASE_URL}/images`, { method: "POST", headers, body });
        if (!res.ok) {
            const errData = await res.json().catch(() => null);
            throw new Error(errData?.message || `Failed to create image: ${res.status} ${res.statusText}`);
        }
        const data = await res.json();
        revalidatePath("/images");
        return data;
    } catch (error) {
        console.error("[createImage]", error);
        throw error;
    }
}

/** PATCH /images/:id — Partially update an image record via JSON or multipart FormData. */
export async function updateImage(id: number, payload: UpdateImagePayload | FormData): Promise<ApiResponse<Image>> {
    const isFormData = typeof FormData !== "undefined" && payload instanceof FormData;
    const headers = await getAuthHeaders(isFormData);
    try {
        const body = isFormData ? payload : JSON.stringify(payload);
        const res = await fetch(`${BASE_URL}/images/${id}`, { method: "PATCH", headers, body });
        if (!res.ok) {
            const errData = await res.json().catch(() => null);
            throw new Error(errData?.message || `Failed to update image ${id}: ${res.status} ${res.statusText}`);
        }
        const data = await res.json();
        revalidatePath("/images");
        return data;
    } catch (error) {
        console.error("[updateImage]", error);
        throw error;
    }
}

/** DELETE /images/:id — Delete an image record. */
export async function deleteImage(id: number): Promise<{ status: string; message: string }> {
    const headers = await getAuthHeaders();
    try {
        const res = await fetch(`${BASE_URL}/images/${id}`, { method: "DELETE", headers });
        if (!res.ok) throw new Error(`Failed to delete image ${id}: ${res.status} ${res.statusText}`);
        const data = await res.json();
        revalidatePath("/images");
        return data;
    } catch (error) {
        console.error("[deleteImage]", error);
        throw error;
    }
}
