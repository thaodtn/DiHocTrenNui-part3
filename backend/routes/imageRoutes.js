const express = require('express');
const router = express.Router();
const ImageController = require('../controllers/ImageController');
const { authenticate, authorize } = require('../middlewares/authorize');
const { handleSingleUpload } = require('../middlewares/upload');
const { ACTIONS, RESOURCES } = require('../data');

// Image Proxy Route (legacy backward-compatibility for local files)
router.get('/proxy/:filename', authenticate, ImageController.proxyImage);

// Optimized Retrieval Routes (defined before generic CRUD to avoid conflicts)
router.get('/student/:studentId', authorize(ACTIONS.READ, RESOURCES.IMAGE), ImageController.getImagesByStudent);
router.get('/range', authorize(ACTIONS.READ, RESOURCES.IMAGE), ImageController.getImagesByRange);

// Standard CRUD Routes for Images with Multipart Upload support
router.get('/', authorize(ACTIONS.READ, RESOURCES.IMAGE), ImageController.getAllImages);
router.get('/:id/url', authorize(ACTIONS.READ, RESOURCES.IMAGE), ImageController.getImageUrl);
router.get('/:id', authorize(ACTIONS.READ, RESOURCES.IMAGE), ImageController.getImageById);
router.post('/', authorize(ACTIONS.CREATE, RESOURCES.IMAGE), handleSingleUpload('image'), ImageController.createImage);
router.patch('/:id', authorize(ACTIONS.UPDATE, RESOURCES.IMAGE), handleSingleUpload('image'), ImageController.updateImage);
router.delete('/:id', authorize(ACTIONS.DELETE, RESOURCES.IMAGE), ImageController.deleteImage);

module.exports = router;
