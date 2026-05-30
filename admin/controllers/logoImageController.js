const fs = require("fs");
const path = require("path");

const LogoImageModel = require("../models/logoImageModel");
const { UPLOAD_ROOT } = require("../middleware/upload");

function toIntOrNull(value) {
  const num = Number(value);
  return Number.isInteger(num) && num > 0 ? num : null;
}

function getActor(req) {
  return {
    user_id:
      toIntOrNull(req.user?.user_id) ||
      toIntOrNull(req.headers["x-admin-id"]) ||
      toIntOrNull(req.body?.user_id) ||
      null,

    admin_name:
      req.user?.admin_name ||
      req.headers["x-admin-name"] ||
      req.body?.admin_name ||
      null,
  };
}

function deleteFileIfExists(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log("🗑️ Deleted file:", filePath);
    }
  } catch (error) {
    console.error("Error deleting file:", error);
  }
}

function imageUrlToFilePath(imageUrl) {
  if (!imageUrl) return null;

  const relativePath = imageUrl.replace(/^\/uploads\//, "");

  return path.join(UPLOAD_ROOT, relativePath);
}

const LogoImageController = {
  // Create new logo/image with file upload
  async create(req, res) {
    try {
      const { name, service_type } = req.body;
      const actor = getActor(req);

      if (!req.file) {
        return res.status(400).json({
          success: false,
          message: "Image file is required",
        });
      }

      if (!name || !name.trim()) {
        deleteFileIfExists(req.file.path);

        return res.status(400).json({
          success: false,
          message: "Name is required",
        });
      }

      if (!service_type || !service_type.trim()) {
        deleteFileIfExists(req.file.path);

        return res.status(400).json({
          success: false,
          message: "Service type is required",
        });
      }

      const image_url = `/uploads/logo_and_image/${req.file.filename}`;

      const result = await LogoImageModel.create(
        {
          name: name.trim(),
          image_url,
          service_type: service_type.trim(),
        },
        actor.user_id,
        actor.admin_name
      );

      if (result.duplicate) {
        deleteFileIfExists(req.file.path);

        return res.status(409).json({
          success: false,
          message: result.message || "Logo/Image name already exists",
        });
      }

      return res.status(201).json({
        success: true,
        message: "Logo/Image created successfully",
        data: result.data,
      });
    } catch (error) {
      if (req.file?.path) {
        deleteFileIfExists(req.file.path);
      }

      console.error("Error creating logo/image:", error);

      return res.status(500).json({
        success: false,
        message: "Internal server error",
        error: error.message,
      });
    }
  },

  // Get all logos/images
  async getAll(req, res) {
    try {
      const {
        page = 1,
        limit = 10,
        search = "",
        service_type = "",
      } = req.query;

      const result = await LogoImageModel.findAll({
        page,
        limit,
        search,
        service_type,
      });

      return res.status(200).json({
        success: true,
        data: result.items,
        pagination: {
          total: result.total,
          page: result.page,
          limit: result.limit,
          totalPages: result.totalPages,
        },
      });
    } catch (error) {
      console.error("Error fetching logos/images:", error);

      return res.status(500).json({
        success: false,
        message: "Internal server error",
        error: error.message,
      });
    }
  },

  // Get single logo/image by ID
  async getById(req, res) {
    try {
      const { id } = req.params;

      const item = await LogoImageModel.findById(id);

      if (!item) {
        return res.status(404).json({
          success: false,
          message: "Logo/Image not found",
        });
      }

      return res.status(200).json({
        success: true,
        data: item,
      });
    } catch (error) {
      console.error("Error fetching logo/image:", error);

      return res.status(500).json({
        success: false,
        message: "Internal server error",
        error: error.message,
      });
    }
  },

  // Update logo/image
  async update(req, res) {
    try {
      const { id } = req.params;
      const { name, service_type } = req.body;
      const actor = getActor(req);

      const existingItem = await LogoImageModel.findById(id);

      if (!existingItem) {
        if (req.file?.path) {
          deleteFileIfExists(req.file.path);
        }

        return res.status(404).json({
          success: false,
          message: "Logo/Image not found",
        });
      }

      const updateData = {};

      if (name && name.trim()) {
        updateData.name = name.trim();
      }

      if (service_type && service_type.trim()) {
        updateData.service_type = service_type.trim();
      }

      if (req.file) {
        updateData.image_url = `/uploads/logo_and_image/${req.file.filename}`;
      }

      if (!updateData.name && !updateData.image_url && !updateData.service_type) {
        if (req.file?.path) {
          deleteFileIfExists(req.file.path);
        }

        return res.status(400).json({
          success: false,
          message: "Nothing to update",
        });
      }

      const result = await LogoImageModel.update(
        id,
        updateData,
        actor.user_id,
        actor.admin_name
      );

      if (result.notFound) {
        if (req.file?.path) {
          deleteFileIfExists(req.file.path);
        }

        return res.status(404).json({
          success: false,
          message: "Logo/Image not found",
        });
      }

      if (result.duplicate) {
        if (req.file?.path) {
          deleteFileIfExists(req.file.path);
        }

        return res.status(409).json({
          success: false,
          message: result.message || "Logo/Image name already exists",
        });
      }

      // Delete old file only after DB update succeeds
      if (req.file && existingItem.image_url) {
        const oldImagePath = imageUrlToFilePath(existingItem.image_url);
        deleteFileIfExists(oldImagePath);
      }

      return res.status(200).json({
        success: true,
        message: "Logo/Image updated successfully",
        data: result.data,
      });
    } catch (error) {
      if (req.file?.path) {
        deleteFileIfExists(req.file.path);
      }

      console.error("Error updating logo/image:", error);

      return res.status(500).json({
        success: false,
        message: "Internal server error",
        error: error.message,
      });
    }
  },

  // Delete logo/image
  async delete(req, res) {
    try {
      const { id } = req.params;
      const actor = getActor(req);

      const existingItem = await LogoImageModel.findById(id);

      if (!existingItem) {
        return res.status(404).json({
          success: false,
          message: "Logo/Image not found",
        });
      }

      const result = await LogoImageModel.delete(
        id,
        actor.user_id,
        actor.admin_name
      );

      if (result.notFound) {
        return res.status(404).json({
          success: false,
          message: "Logo/Image not found",
        });
      }

      const imagePath = imageUrlToFilePath(existingItem.image_url);
      deleteFileIfExists(imagePath);

      return res.status(200).json({
        success: true,
        message: "Logo/Image deleted successfully",
      });
    } catch (error) {
      console.error("Error deleting logo/image:", error);

      return res.status(500).json({
        success: false,
        message: "Internal server error",
        error: error.message,
      });
    }
  },

  // Bulk delete logos/images
  async bulkDelete(req, res) {
    try {
      const { ids } = req.body;
      const actor = getActor(req);

      if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({
          success: false,
          message: "Valid IDs array is required",
        });
      }

      const result = await LogoImageModel.bulkDelete(
        ids,
        actor.user_id,
        actor.admin_name
      );

      if (result.items && result.items.length > 0) {
        result.items.forEach((item) => {
          const imagePath = imageUrlToFilePath(item.image_url);
          deleteFileIfExists(imagePath);
        });
      }

      return res.status(200).json({
        success: true,
        message: `${result.count} item(s) deleted successfully`,
        deletedCount: result.count,
      });
    } catch (error) {
      console.error("Error bulk deleting logos/images:", error);

      return res.status(500).json({
        success: false,
        message: "Internal server error",
        error: error.message,
      });
    }
  },
};

module.exports = LogoImageController;