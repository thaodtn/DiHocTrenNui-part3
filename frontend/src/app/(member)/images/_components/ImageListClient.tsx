"use client";

import React, { useState, useMemo, useEffect, useCallback, useRef, useTransition } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import {
  Images,
  Download,
  Trash2,
  Pencil,
  ChevronLeft,
  ChevronRight,
  Calendar,
  User,
  Plus,
  X,
  Image as ImageIcon,
  Sparkles,
  RefreshCw,
  Upload,
  Loader2
} from "lucide-react";
import Image from "next/image";
import ListToolbar from "@/components/member/common/ListToolbar";
import { usePermission } from "@/contexts/PermissionContext";
import {
  Image as ImageType,
  getAllImages,
  createImage,
  updateImage,
  deleteImage,
  getImagesByStudent,
  getImagesByRange,
  getImageUrl
} from "@/services/images";
import { Student } from "@/services/students";

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────
const PAGE_SIZE_OPTIONS = [8, 16, 24];



// ─────────────────────────────────────────────────────────────
// Safe Image Component (with token refresh & error fallback)
// ─────────────────────────────────────────────────────────────
function SafeImage({
  src,
  alt,
  fallbackSrc = "/images/default-avatar.jpg",
  imageId,
  ...props
}: any) {
  const [imgSrc, setImgSrc] = useState(src);
  const [retried, setRetried] = useState(false);

  useEffect(() => {
    setImgSrc(src);
    setRetried(false);
  }, [src]);

  const handleError = async () => {
    // If not already retried and imageId is available, attempt a single refresh
    if (!retried && imageId) {
      setRetried(true);
      try {
        const res = await getImageUrl(imageId);
        if (res && res.data && res.data.url) {
          setImgSrc(res.data.url);
          return;
        }
      } catch (e) {
        console.warn("[SafeImage] Refresh failed, using fallback:", e);
      }
    }
    setImgSrc(fallbackSrc);
  };

  return (
    <Image
      {...props}
      src={imgSrc}
      alt={alt}
      onError={handleError}
    />
  );
}

const SEARCH_DEBOUNCE_MS = 400;

interface Props {
  initialImages: ImageType[];
  students: Student[];
  total: number;
  initialPage: number;
  initialPageSize: number;
  token: string;
  initialSearch: string;
}

export default function ImageListClient({
  initialImages,
  students,
  total: serverTotal,
  initialPage,
  initialPageSize,
  token,
  initialSearch,
}: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const { hasPermission } = usePermission();
  const [isPending, startTransition] = useTransition();

  // Primary list state
  const [displayedImages, setDisplayedImages] = useState<ImageType[]>(initialImages);
  const [total, setTotal] = useState(serverTotal);
  const [loading, setLoading] = useState(false);

  // Filters State
  const [search, setSearch] = useState(initialSearch);
  const [selectedStudent, setSelectedStudent] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [activeFilterMode, setActiveFilterMode] = useState<"none" | "student" | "range">("none");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Modal State
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [modalMode, setModalMode] = useState<"create" | "edit">("create");
  const [editingImage, setEditingImage] = useState<ImageType | null>(null);

  // Modal Form Inputs
  const [formStudentId, setFormStudentId] = useState("");
  const [formUrl, setFormUrl] = useState("");
  const [formFileData, setFormFileData] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string>("");
  const [formTimestamp, setFormTimestamp] = useState("");
  const [formEventId, setFormEventId] = useState("");
  const [formMonth, setFormMonth] = useState("");
  const [formError, setFormError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);

  // ─── Proxy URL Helpers ───────────────────────────────────────────────────────
  const getProxiedUrl = (url: string) => {
    if (!url) return "";
    if (url.startsWith("http://") || url.startsWith("https://")) {
      if (url.includes("/images/proxy/")) {
        try {
          const urlObj = new URL(url);
          if (!urlObj.searchParams.has("token") && token) {
            urlObj.searchParams.set("token", token);
          }
          return urlObj.toString();
        } catch {
          return url;
        }
      }
      return url;
    }

    // Extract filename from relative path
    let filename = url;
    if (filename.includes("/")) {
      filename = filename.split("/").pop() || "";
    }

    const tokenParam = token ? `?token=${token}` : "";
    const apiBase = process.env.NEXT_PUBLIC_API_URL;
    return `${apiBase}/images/proxy/${filename}${tokenParam}`;
  };

  const sanitizeUrlForDatabase = (url: string) => {
    if (!url) return "";
    if (url.includes("/images/proxy/")) {
      const parts = url.split("/images/proxy/");
      const filenameWithQuery = parts[1];
      const filename = filenameWithQuery.split("?")[0];
      return filename;
    }
    return url;
  };

  // Keep student name mapping for quick display lookup
  const studentMap = useMemo(() => {
    return new Map(students.map(s => [s.id, s.full_name]));
  }, [students]);

  // Sync with paginated props from server when no custom filters are active
  useEffect(() => {
    if (activeFilterMode === "none") {
      setDisplayedImages(initialImages);
      setTotal(serverTotal);
    }
  }, [initialImages, serverTotal, activeFilterMode]);

  // Keep local state in sync when URL-driven props change
  useEffect(() => {
    setSearch(initialSearch);
  }, [initialSearch]);

  // Pagination parameters from URL
  const page = initialPage;
  const pageSize = initialPageSize;

  const navigateWithParams = useCallback(
    (overrides: { page?: number; pageSize?: number; search?: string }) => {
      const params = new URLSearchParams(searchParams.toString());

      const newPage = overrides.page ?? 1;
      const newPageSize = overrides.pageSize ?? pageSize;
      const newSearch = overrides.search ?? search;

      params.set("page", String(newPage));
      params.set("pageSize", String(newPageSize));

      if (newSearch) {
        params.set("search", newSearch);
      } else {
        params.delete("search");
      }

      startTransition(() => {
        router.push(`${pathname}?${params.toString()}`);
      });
    },
    [searchParams, pathname, pageSize, search, router, startTransition]
  );

  // Debounced search handler
  const handleSearch = useCallback(
    (v: string) => {
      setSearch(v);
      // Reset other custom filter modes
      setActiveFilterMode("none");
      setSelectedStudent("");
      setStartDate("");
      setEndDate("");

      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        navigateWithParams({ search: v, page: 1 });
      }, SEARCH_DEBOUNCE_MS);
    },
    [navigateWithParams]
  );

  // Cleanup debounce on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  // ─── Fetching / Filter Actions ─────────────────────────────────────────────

  // Fetch images by Student
  const handleStudentFilterChange = async (studentId: string) => {
    setSelectedStudent(studentId);
    setStartDate("");
    setEndDate("");

    if (!studentId) {
      setActiveFilterMode("none");
      setDisplayedImages(initialImages);
      setTotal(serverTotal);
      return;
    }

    setLoading(true);
    setActiveFilterMode("student");
    try {
      // Backend expects studentId string (e.g. HS0001)
      const res = await getImagesByStudent(Number(studentId) || (studentId as any));
      setDisplayedImages(res.data || []);
      setTotal(res.data?.length || 0);
    } catch (err) {
      console.error(err);
      setDisplayedImages([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  };

  // Fetch images by Time Range
  const handleRangeFilterSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!startDate || !endDate) return;

    setSelectedStudent("");
    setLoading(true);
    setActiveFilterMode("range");
    try {
      const res = await getImagesByRange({ start: startDate, end: endDate });
      setDisplayedImages(res.data || []);
      setTotal(res.data?.length || 0);
    } catch (err) {
      console.error(err);
      setDisplayedImages([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  };

  const handleClearFilters = () => {
    setSearch("");
    setSelectedStudent("");
    setStartDate("");
    setEndDate("");
    setActiveFilterMode("none");
    setDisplayedImages(initialImages);
    setTotal(serverTotal);
    // Reset pagination to first page
    const params = new URLSearchParams();
    params.set("page", "1");
    params.set("pageSize", String(pageSize));
    startTransition(() => {
      router.push(`${pathname}?${params.toString()}`);
    });
  };

  // Derived: filtered rows locally based on search term
  const filteredImages = displayedImages;

  // ─── Modal Functions ───────────────────────────────────────────────────────

  const openCreateModal = () => {
    setModalMode("create");
    setEditingImage(null);
    setFormStudentId(students[0]?.id || "");
    setFormUrl("");
    setFormFileData("");
    if (previewUrl && previewUrl.startsWith("blob:")) {
      URL.revokeObjectURL(previewUrl);
    }
    setSelectedFile(null);
    setPreviewUrl("");
    setFormTimestamp(new Date().toISOString().substring(0, 10));
    setFormEventId("EVT_" + new Date().toISOString().substring(5, 7) + "_" + new Date().getFullYear());
    setFormMonth(new Date().toISOString().substring(5, 7) + "/" + new Date().getFullYear());
    setFormError("");
    setIsModalOpen(true);
  };

  const openEditModal = (img: ImageType) => {
    setModalMode("edit");
    setEditingImage(img);
    setFormStudentId(String(img.student_id));
    setFormUrl(img.url);
    setFormFileData("");
    if (previewUrl && previewUrl.startsWith("blob:")) {
      URL.revokeObjectURL(previewUrl);
    }
    setSelectedFile(null);
    setPreviewUrl(img.url ? getProxiedUrl(img.url) : "");
    setFormTimestamp(img.timestamp ? img.timestamp.substring(0, 10) : new Date().toISOString().substring(0, 10));
    setFormEventId(String(img.event_id || ""));
    setFormMonth(String(img.metadata?.month || ""));
    setFormError("");
    setIsModalOpen(true);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (previewUrl && previewUrl.startsWith("blob:")) {
      URL.revokeObjectURL(previewUrl);
    }

    setSelectedFile(file);
    setFormUrl(file.name);
    setFormFileData("");

    const objectUrl = URL.createObjectURL(file);
    setPreviewUrl(objectUrl);
  };

  const handleModalSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError("");
    setSubmitting(true);

    if (!formStudentId || (!formUrl && !selectedFile) || !formTimestamp) {
      setFormError("Vui lòng điền đầy đủ các thông tin bắt buộc.");
      setSubmitting(false);
      return;
    }

    try {
      if (selectedFile) {
        // Multipart/form-data upload directly to backend -> Cloudinary
        const formData = new FormData();
        formData.append("image", selectedFile);
        formData.append("student_id", String(formStudentId));
        formData.append("timestamp", new Date(formTimestamp).toISOString());
        if (formEventId) formData.append("event_id", formEventId);
        if (formMonth) formData.append("month", formMonth);

        if (modalMode === "create") {
          await createImage(formData);
        } else if (modalMode === "edit" && editingImage) {
          await updateImage(editingImage.id, formData);
        }
      } else {
        // Existing URL or update without replacing file
        const payload = {
          student_id: formStudentId as any,
          url: sanitizeUrlForDatabase(formUrl),
          timestamp: new Date(formTimestamp).toISOString(),
          metadata: {
            month: formMonth,
          },
          event_id: formEventId || undefined,
        };

        if (modalMode === "create") {
          await createImage(payload);
        } else if (modalMode === "edit" && editingImage) {
          await updateImage(editingImage.id, payload);
        }
      }

      setIsModalOpen(false);
      setSelectedFile(null);
      if (previewUrl && previewUrl.startsWith("blob:")) {
        URL.revokeObjectURL(previewUrl);
      }
      setPreviewUrl("");
      setFormFileData("");
      router.refresh();

      // If we are in custom filtering, reload that filter, else let the prop update
      if (activeFilterMode === "student") {
        handleStudentFilterChange(selectedStudent);
      } else if (activeFilterMode === "range") {
        const res = await getImagesByRange({ start: startDate, end: endDate });
        setDisplayedImages(res.data || []);
      }
    } catch (err: any) {
      console.error(err);
      setFormError(err.message || "Đã xảy ra lỗi khi lưu hình ảnh.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeleteImage = async (id: number) => {
    // Bước 1: yêu cầu xác nhận inline
    if (confirmDeleteId !== id) {
      setConfirmDeleteId(id);
      return;
    }
    // Bước 2: đã xác nhận → thực hiện xoá
    setConfirmDeleteId(null);
    try {
      await deleteImage(id);
      router.refresh();
      // Update local state directly to show immediate deletion response
      setDisplayedImages(prev => prev.filter(img => img.id !== id));
      setTotal(prev => Math.max(0, prev - 1));
    } catch (err: any) {
      console.error("Lỗi khi xoá hình ảnh:", err);
    }
  };

  // ─── Pagination Math ────────────────────────────────────────────────────────
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

  return (
    <>
      {/* ── Toolbar: search + filter actions ── */}
      <ListToolbar
        searchPlaceholder="Tìm theo học sinh, mã HS, tháng..."
        searchValue={search}
        onSearchChange={handleSearch}
        addLabel="Tải ảnh lên"
        onAdd={hasPermission("IMAGE_CREATE") ? openCreateModal : undefined}
        extras={
          <div className="flex flex-wrap items-center gap-3">
            {isPending && (
              <div className="flex items-center gap-1.5 text-primary-700">
                <Loader2 size={16} className="animate-spin" />
                <span className="text-xs font-medium">Đang tìm...</span>
              </div>
            )}
            {/* Student Dropdown Filter */}
            <div className="relative">
              <select
                id="filter-student"
                value={selectedStudent}
                onChange={(e) => handleStudentFilterChange(e.target.value)}
                className="h-[42px] pl-3 pr-8 text-sm border border-gray-200 rounded-xl bg-white focus:outline-none focus:border-primary-700 focus:ring-1 focus:ring-primary-700/30 transition-colors text-gray-700 cursor-pointer appearance-none min-w-[180px]"
                style={{
                  backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%236b7280' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E")`,
                  backgroundRepeat: "no-repeat",
                  backgroundPosition: "right 10px center",
                }}
              >
                <option value="">Lọc theo học sinh</option>
                {students.map((std) => (
                  <option key={std.id} value={std.id}>
                    {std.full_name} ({std.id})
                  </option>
                ))}
              </select>
            </div>

            {/* Date Range Picker Form */}
            <form onSubmit={handleRangeFilterSubmit} className="flex items-center gap-2 bg-white px-3 py-1.5 border border-gray-200 rounded-xl text-sm">
              <Calendar size={14} className="text-gray-400" />
              <input
                type="date"
                required
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="border-none focus:outline-none focus:ring-0 text-xs text-gray-700 cursor-pointer"
                title="Từ ngày"
              />
              <span className="text-gray-300">—</span>
              <input
                type="date"
                required
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="border-none focus:outline-none focus:ring-0 text-xs text-gray-700 cursor-pointer"
                title="Đến ngày"
              />
              <button
                type="submit"
                className="px-2 py-1 rounded bg-primary-900 text-white text-xs font-semibold hover:bg-primary-800 transition-colors"
              >
                Lọc
              </button>
            </form>

            {/* Clear Filters Button */}
            {(search || selectedStudent || startDate || endDate || activeFilterMode !== "none") && (
              <button
                type="button"
                onClick={handleClearFilters}
                className="h-[42px] px-3 border border-dashed border-gray-300 rounded-xl text-xs font-medium text-gray-500 hover:text-red-600 hover:border-red-300 hover:bg-red-50/20 transition-all flex items-center gap-1"
              >
                <X size={14} /> Xoá lọc
              </button>
            )}
          </div>
        }
      />

      {/* ── Filter status badge ── */}
      {activeFilterMode !== "none" && (
        <div className="mb-4 flex items-center justify-between p-3 bg-primary-50 border border-primary-100 rounded-xl">
          <span className="text-xs text-primary-900 font-medium flex items-center gap-1.5">
            <Sparkles size={13} className="animate-pulse" />
            Đang lọc: {activeFilterMode === "student" ? `Hình ảnh học sinh ${studentMap.get(selectedStudent)} (${selectedStudent})` : `Hình ảnh từ ${startDate} đến ${endDate}`}
          </span>
          <button
            onClick={handleClearFilters}
            className="text-xs text-primary-900 hover:underline font-semibold"
          >
            Quay lại thư viện chuẩn
          </button>
        </div>
      )}

      {/* ── Main Gallery Cards ── */}
      {loading ? (
        <div className="flex flex-col items-center justify-center py-24 text-gray-400">
          <RefreshCw size={36} className="animate-spin mb-3 text-primary-900" />
          <p className="text-sm font-medium">Đang tải danh sách hình ảnh...</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-6">
          {filteredImages.map((img) => {
            const studentName = studentMap.get(String(img.student_id)) || "Học sinh không rõ";
            return (
              <div
                key={img.id}
                className="group relative bg-white rounded-2xl border border-gray-100 overflow-hidden shadow-sm hover:shadow-md hover:-translate-y-1 transition-all duration-300"
              >
                {/* Image Box */}
                <div className="relative w-full aspect-[4/3] bg-gray-50 border-b border-gray-100 overflow-hidden">
                  <SafeImage
                    src={`${img.url}${img.url.includes('?') ? '&' : '?'}_t=${img.timestamp ? new Date(img.timestamp).getTime() : Date.now()}`}
                    alt={`Ảnh HS: ${studentName}`}
                    imageId={img.id}
                    fill
                    className="object-cover group-hover:scale-105 transition-transform duration-500"
                    sizes="(max-width: 640px) 100vw, (max-width: 768px) 50vw, 33vw"
                    unoptimized
                  />
                  {/* Floating Action Overlay */}
                  <div className="absolute inset-0 bg-black/0 group-hover:bg-black/35 transition-colors duration-300 flex items-center justify-center gap-3 opacity-0 group-hover:opacity-100">
                    <a
                      href={img.url}
                      download
                      target="_blank"
                      rel="noopener noreferrer"
                      className="w-10 h-10 rounded-full bg-white flex items-center justify-center text-gray-700 hover:text-primary-900 hover:scale-105 shadow transition-all duration-200"
                      title="Mở hình ảnh trong tab mới"
                    >
                      <Download size={16} />
                    </a>
                    {hasPermission("IMAGE_UPDATE") && (
                      <button
                        onClick={() => openEditModal(img)}
                        className="w-10 h-10 rounded-full bg-white flex items-center justify-center text-gray-700 hover:text-primary-900 hover:scale-105 shadow transition-all duration-200"
                        title="Chỉnh sửa hình ảnh"
                      >
                        <Pencil size={16} />
                      </button>
                    )}
                    {hasPermission("IMAGE_DELETE") && (
                      confirmDeleteId === img.id ? (
                        <div className="flex items-center gap-1.5 bg-white rounded-full px-2 py-1 shadow">
                          <button
                            onClick={() => handleDeleteImage(img.id)}
                            className="px-2 py-0.5 rounded-full bg-red-500 text-white text-[10px] font-bold hover:bg-red-600 transition-colors"
                            title="Xác nhận xoá"
                          >
                            Xoá
                          </button>
                          <button
                            onClick={() => setConfirmDeleteId(null)}
                            className="px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 text-[10px] font-bold hover:bg-gray-200 transition-colors"
                            title="Huỷ"
                          >
                            Huỷ
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => handleDeleteImage(img.id)}
                          className="w-10 h-10 rounded-full bg-white flex items-center justify-center text-gray-700 hover:text-red-600 hover:scale-105 shadow transition-all duration-200"
                          title="Xoá hình ảnh"
                        >
                          <Trash2 size={16} />
                        </button>
                      )
                    )}
                  </div>
                </div>

                {/* Meta details */}
                <div className="p-4 space-y-2">
                  <div className="flex items-center gap-1.5 text-xs text-gray-500">
                    <User size={13} className="text-gray-400" />
                    <span className="font-semibold text-gray-700 truncate">{studentName}</span>
                    <span className="text-gray-300 font-normal">|</span>
                    <span className="font-mono text-gray-400 text-[10px]">{img.student_id}</span>
                  </div>

                  <div className="flex items-center justify-between text-xs mt-1">
                    {img.metadata?.month && (
                      <span className="text-xs text-primary-900 bg-primary-900/10 px-2.5 py-0.5 rounded-full font-semibold">
                        Tháng {img.metadata.month as string}
                      </span>
                    )}
                    {img.event_id && (
                      <span className="text-[10px] text-gray-400 font-mono" title={`Event: ${img.event_id}`}>
                        {img.event_id}
                      </span>
                    )}
                  </div>

                  <div className="pt-2 border-t border-gray-50 flex items-center justify-between text-[11px] text-gray-400">
                    <span>Mã ảnh: #{img.id}</span>
                    <span>{new Date(img.timestamp).toLocaleDateString("vi-VN", {
                      day: "2-digit",
                      month: "2-digit",
                      year: "numeric",
                    })}</span>
                  </div>
                </div>
              </div>
            );
          })}

          {filteredImages.length === 0 && (
            <div className="col-span-full py-20 text-center text-gray-400 bg-white rounded-2xl border border-dashed border-gray-200">
              <Images size={40} className="mx-auto mb-3 opacity-30 text-primary-900" />
              <p className="text-sm font-medium">Không tìm thấy hình ảnh nào phù hợp</p>
              <p className="text-xs text-gray-400 mt-1">Vui lòng thử điều chỉnh lại bộ lọc hoặc tải ảnh mới lên</p>
            </div>
          )}
        </div>
      )}

      {/* ── Pagination controls (only show in default mode where pages apply) ── */}
      {activeFilterMode === "none" && !loading && total > 0 && (
        <div className="mt-8 flex flex-col sm:flex-row items-center justify-between gap-3 px-1 py-2 text-sm text-gray-500">
          <span>
            Hiển thị{" "}
            <span className="font-semibold text-gray-700">
              {from}–{to}
            </span>{" "}
            trong tổng số{" "}
            <span className="font-semibold text-gray-700">{total}</span> hình ảnh
          </span>

          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-gray-400">Ảnh/trang:</span>
              <select
                value={pageSize}
                onChange={(e) => {
                  navigateWithParams({ page: 1, pageSize: Number(e.target.value) });
                }}
                className="border border-gray-200 rounded-lg px-2 py-1 text-xs bg-white focus:outline-none focus:border-primary-700 cursor-pointer"
              >
                {PAGE_SIZE_OPTIONS.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex items-center gap-1">
              <button
                onClick={() => navigateWithParams({ page: page - 1 })}
                disabled={page <= 1}
                className="p-1.5 rounded-lg border border-gray-200 bg-white hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                aria-label="Trang trước"
              >
                <ChevronLeft size={14} />
              </button>

              {Array.from({ length: totalPages }, (_, i) => i + 1)
                .filter((p) => p === 1 || p === totalPages || Math.abs(p - page) <= 1)
                .reduce<(number | "…")[]>((acc, p, i, arr) => {
                  if (i > 0 && p - (arr[i - 1] as number) > 1) acc.push("…");
                  acc.push(p);
                  return acc;
                }, [])
                .map((p, i) =>
                  p === "…" ? (
                    <span key={`ellipsis-${i}`} className="px-1 text-gray-400">
                      …
                    </span>
                  ) : (
                    <button
                      key={p}
                      onClick={() => navigateWithParams({ page: p as number })}
                      className={[
                        "w-7 h-7 rounded-lg text-xs font-medium transition-colors",
                        p === page
                          ? "bg-primary-900 text-white shadow-sm"
                          : "border border-gray-200 bg-white hover:bg-gray-50 text-gray-600",
                      ].join(" ")}
                    >
                      {p}
                    </button>
                  )
                )}

              <button
                onClick={() => navigateWithParams({ page: page + 1 })}
                disabled={page >= totalPages}
                className="p-1.5 rounded-lg border border-gray-200 bg-white hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                aria-label="Trang sau"
              >
                <ChevronRight size={14} />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Add / Edit Modal ── */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-gray-900/60 backdrop-blur-sm transition-opacity"
            onClick={() => setIsModalOpen(false)}
          />

          {/* Modal Content container */}
          <div className="relative bg-white rounded-3xl shadow-xl border border-gray-100 max-w-lg w-full overflow-hidden transform transition-all flex flex-col max-h-[90vh]">
            {/* Header */}
            <div className="px-6 py-4 bg-gradient-to-r from-primary-950 to-primary-900 text-white flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ImageIcon size={18} className="text-white" />
                <h3 className="font-bold text-lg">
                  {modalMode === "create" ? "Tải ảnh học sinh lên" : "Chỉnh sửa hình ảnh"}
                </h3>
              </div>
              <button
                onClick={() => setIsModalOpen(false)}
                className="text-white/80 hover:text-white transition-colors"
              >
                <X size={20} />
              </button>
            </div>

            {/* Body Form */}
            <form onSubmit={handleModalSubmit} className="flex-1 overflow-y-auto p-6 space-y-4">
              {formError && (
                <div className="p-3 text-xs text-red-600 bg-red-50 rounded-xl border border-red-100 font-medium">
                  {formError}
                </div>
              )}

              {/* Form Input: Student Dropdown */}
              <div className="space-y-1.5">
                <label className="text-xs font-bold text-gray-700 uppercase tracking-wider">Học sinh liên kết *</label>
                <select
                  required
                  value={formStudentId}
                  onChange={(e) => setFormStudentId(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-primary-700 focus:ring-1 focus:ring-primary-700/30 bg-white"
                >
                  <option value="" disabled>-- Chọn học sinh --</option>
                  {students.map((std) => (
                    <option key={std.id} value={std.id}>
                      {std.full_name} ({std.id})
                    </option>
                  ))}
                </select>
              </div>

              {/* Form Input: Local Image Upload Selector */}
              <div className="space-y-1.5">
                <label className="text-xs font-bold text-gray-700 uppercase tracking-wider block">Chọn tệp hình ảnh *</label>
                <div className="flex items-center gap-3">
                  <label className="flex items-center gap-2 px-4 py-2 border border-primary-900 border-dashed rounded-xl cursor-pointer hover:bg-primary-900/5 text-primary-900 text-xs font-bold transition-all">
                    <Upload size={14} />
                    <span>Chọn tệp từ máy tính</span>
                    <input
                      type="file"
                      accept="image/*"
                      onChange={handleFileChange}
                      className="hidden"
                    />
                  </label>
                  {formUrl && (
                    <span className="text-xs text-gray-500 truncate max-w-[200px]" title={formUrl}>
                      {formUrl}
                    </span>
                  )}
                </div>
              </div>

              {/* Form Input: Image URL */}
              <div className="space-y-1.5">
                <label className="text-xs font-bold text-gray-700 uppercase tracking-wider">Đường dẫn hình ảnh (URL) {selectedFile ? "(Tự động từ tệp đã chọn)" : "*"}</label>
                <input
                  type="text"
                  required={!selectedFile}
                  value={formUrl}
                  onChange={(e) => {
                    setFormUrl(e.target.value);
                    setFormFileData("");
                    setSelectedFile(null);
                    if (previewUrl && previewUrl.startsWith("blob:")) {
                      URL.revokeObjectURL(previewUrl);
                    }
                    setPreviewUrl("");
                  }}
                  placeholder="https://example.com/image.jpg hoặc chọn tệp bên trên"
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-primary-700 focus:ring-1 focus:ring-primary-700/30"
                />
              </div>

              {/* Image Preview Box */}
              {(previewUrl || formUrl || formFileData) && (
                <div className="space-y-1 bg-gray-50 p-2.5 rounded-xl border border-gray-100">
                  <span className="text-[10px] text-gray-400 font-medium block">Xem trước ảnh:</span>
                  <div className="relative w-full aspect-[4/3] rounded-lg overflow-hidden border border-gray-200 bg-white">
                    <SafeImage
                      src={previewUrl || formFileData || (formUrl ? `${getProxiedUrl(formUrl)}${getProxiedUrl(formUrl).includes('?') ? '&' : '?'}_t=${editingImage?.timestamp ? new Date(editingImage.timestamp).getTime() : Date.now()}` : "")}
                      alt="Xem trước hình ảnh"
                      fill
                      className="object-cover"
                      unoptimized
                    />
                  </div>
                </div>
              )}

              {/* Grid 2-column inputs */}
              <div className="grid grid-cols-2 gap-4">
                {/* Timestamp date */}
                <div className="space-y-1.5">
                  <label className="text-xs font-bold text-gray-700 uppercase tracking-wider">Ngày đăng *</label>
                  <input
                    type="date"
                    required
                    value={formTimestamp}
                    onChange={(e) => setFormTimestamp(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-primary-700 focus:ring-1 focus:ring-primary-700/30"
                  />
                </div>

                {/* Event ID */}
                <div className="space-y-1.5">
                  <label className="text-xs font-bold text-gray-700 uppercase tracking-wider">Mã sự kiện (Event ID)</label>
                  <input
                    type="text"
                    value={formEventId}
                    onChange={(e) => setFormEventId(e.target.value)}
                    placeholder="EVT_10_2025"
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-primary-700 focus:ring-1 focus:ring-primary-700/30"
                  />
                </div>
              </div>

              {/* Metadata Month */}
              <div className="space-y-1.5">
                <label className="text-xs font-bold text-gray-700 uppercase tracking-wider">Tháng / Năm hỗ trợ (Metadata)</label>
                <input
                  type="text"
                  value={formMonth}
                  onChange={(e) => setFormMonth(e.target.value)}
                  placeholder="ví dụ: 10/2025"
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-primary-700 focus:ring-1 focus:ring-primary-700/30"
                />
              </div>

              {/* Action Buttons */}
              <div className="flex justify-end gap-3 pt-4 border-t border-gray-100">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  disabled={submitting}
                  className="px-4 py-2 rounded-xl border border-gray-200 bg-white text-sm font-medium text-gray-600 hover:bg-gray-50 transition-colors disabled:opacity-50"
                >
                  Huỷ
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-4 py-2 rounded-xl bg-primary-900 text-white text-sm font-semibold hover:bg-primary-800 transition-colors disabled:opacity-50 flex items-center gap-1.5"
                >
                  {submitting && <RefreshCw size={14} className="animate-spin" />}
                  {modalMode === "create" ? "Tải lên" : "Lưu thay đổi"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
