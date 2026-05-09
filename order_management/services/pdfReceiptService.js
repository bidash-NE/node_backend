// services/pdfReceiptService.js
const PDFDocument = require("pdfkit");
const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");

class PDFReceiptService {
  constructor() {
    // Path to seal image
    this.sealPath = path.join(__dirname, "../assets/seals/official-seal.png");
  }

  async downloadImage(url) {
    return new Promise((resolve) => {
      if (!url) return resolve(null);

      if (!url.startsWith("http")) {
        return resolve(null);
      }

      const client = url.startsWith("https") ? https : http;
      const request = client.get(url, (response) => {
        if (response.statusCode === 301 || response.statusCode === 302) {
          if (response.headers.location) {
            this.downloadImage(response.headers.location).then(resolve);
            return;
          }
        }

        if (response.statusCode !== 200) {
          return resolve(null);
        }

        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const buffer = Buffer.concat(chunks);
          resolve(buffer);
        });
      });

      request.on("error", (err) => {
        console.error("Image download failed:", err.message);
        resolve(null);
      });

      request.setTimeout(5000, () => {
        request.destroy();
        resolve(null);
      });
    });
  }

  async generateOrderReceipt(orderData) {
    return new Promise(async (resolve, reject) => {
      try {
        const doc = new PDFDocument({
          size: "A4",
          margin: 50,
          layout: "portrait",
        });

        const chunks = [];
        doc.on("data", (chunk) => chunks.push(chunk));
        doc.on("end", () => resolve(Buffer.concat(chunks)));
        doc.on("error", reject);

        let currentY = 40;

        // ============ LETTERHEAD: NAME LEFT, LOGO RIGHT ============
        let logoBuffer = null;
        let logoDownloaded = false;

        if (orderData.business_logo) {
          logoBuffer = await this.downloadImage(orderData.business_logo);
          if (logoBuffer) {
            logoDownloaded = true;
          }
        }

        // Business Name (LEFT SIDE)
        doc
          .fontSize(16)
          .font("Helvetica-Bold")
          .text(orderData.business_name || "TabDhey", 50, currentY, {
            width: 350,
          });

        // Business Address
        doc
          .fontSize(8)
          .font("Helvetica")
          .text(
            orderData.business_address || "Thimphu, Bhutan",
            50,
            currentY + 20,
            { width: 350 },
          );

        // Logo (RIGHT SIDE)
        if (logoDownloaded && logoBuffer) {
          try {
            doc.image(logoBuffer, 480, currentY, { width: 60, height: 60 });
          } catch (e) {
            console.error("Logo placement error:", e);
          }
        }

        // Divider line
        const headerBottom = currentY + 70;
        doc
          .moveTo(50, headerBottom)
          .lineTo(550, headerBottom)
          .lineWidth(1)
          .stroke();

        currentY = headerBottom + 15;

        // ============ RECEIPT TITLE ============
        doc
          .fontSize(14)
          .font("Helvetica-Bold")
          .text("ORDER RECEIPT", 50, currentY, { align: "center" });

        currentY = doc.y + 20;

        // ============ ORDER INFO SECTION ============
        doc.fontSize(9).font("Helvetica");

        doc.text(`Order #: ${orderData.order_id}`, 50, currentY);
        doc.text(
          `Date: ${orderData.delivered_at ? new Date(orderData.delivered_at).toLocaleString() : "N/A"}`,
          50,
          currentY + 15,
        );
        doc.text(
          `Payment Method: ${orderData.payment_method || "N/A"}`,
          50,
          currentY + 30,
        );
        doc.text(`Delivery Status: ${orderData.status}`, 300, currentY);
        if (orderData.delivered_at) {
          doc.text(
            `Delivery Time: ${new Date(orderData.delivered_at).toLocaleString()}`,
            300,
            currentY + 15,
          );
        }

        currentY = currentY + 55;

        // ============ CUSTOMER INFO SECTION ============
        doc
          .fontSize(10)
          .font("Helvetica-Bold")
          .text("Customer Information:", 50, currentY);
        currentY = doc.y + 5;

        doc.fontSize(9).font("Helvetica");

        doc.text(`Name: ${orderData.customer_name}`, 50, currentY + 10);
        doc.text(`Email: ${orderData.customer_email}`, 50, currentY + 25);
        doc.text(
          `Phone: ${orderData.customer_phone || "N/A"}`,
          50,
          currentY + 40,
        );

        // Delivery address with wrapping
        const addressText = `Delivery Address: ${orderData.delivery_address}`;
        doc.text(addressText, 50, currentY + 55, { width: 460 });

        const addressHeight = doc.heightOfString(addressText, { width: 460 });
        currentY = currentY + 80 + Math.max(0, addressHeight - 20);

        currentY += 15;

        // ============ ITEMS TABLE ============
        const tableTop = currentY;
        const col1 = 50;
        const col2 = 350;
        const col3 = 415;
        const col4 = 495;
        const tableLeft = 45;
        const tableRight = 555;

        doc.rect(tableLeft, tableTop - 5, tableRight - tableLeft, 28).stroke();
        doc
          .moveTo(col2, tableTop - 5)
          .lineTo(col2, tableTop + 23)
          .stroke();
        doc
          .moveTo(col3, tableTop - 5)
          .lineTo(col3, tableTop + 23)
          .stroke();
        doc
          .moveTo(col4, tableTop - 5)
          .lineTo(col4, tableTop + 23)
          .stroke();

        doc.font("Helvetica-Bold").fontSize(9);
        doc.text("Item", col1, tableTop + 5);
        doc.text("Qty", col2 + 18, tableTop + 5);
        doc.text("Price", col3 + 12, tableTop + 5);
        doc.text("Total", col4, tableTop + 5);

        doc
          .moveTo(tableLeft, tableTop + 23)
          .lineTo(tableRight, tableTop + 23)
          .stroke();

        let tableY = tableTop + 28;

        if (orderData.items && orderData.items.length > 0) {
          for (let i = 0; i < orderData.items.length; i++) {
            const item = orderData.items[i];
            const itemName = item.menu_name || "Item";
            const quantity = item.quantity || 0;
            const price = item.price_per_unit || 0;
            const total = item.subtotal || quantity * price;

            const itemHeight = doc.heightOfString(itemName, { width: 290 });
            const rowHeight = Math.max(itemHeight + 18, 30);

            doc
              .rect(tableLeft, tableY - 5, tableRight - tableLeft, rowHeight)
              .stroke();
            doc
              .moveTo(col2, tableY - 5)
              .lineTo(col2, tableY + rowHeight - 5)
              .stroke();
            doc
              .moveTo(col3, tableY - 5)
              .lineTo(col3, tableY + rowHeight - 5)
              .stroke();
            doc
              .moveTo(col4, tableY - 5)
              .lineTo(col4, tableY + rowHeight - 5)
              .stroke();

            doc.font("Helvetica").fontSize(8);
            doc.text(itemName, col1, tableY + 2, { width: 290, lineGap: 2 });
            doc.text(quantity.toString(), col2 + 20, tableY + 2);

            const priceText = `Nu ${price.toFixed(2)}`;
            const priceWidth = doc.widthOfString(priceText);
            doc.text(priceText, col3 + 65 - priceWidth, tableY + 2);

            const totalText = `Nu ${total.toFixed(2)}`;
            const totalWidth = doc.widthOfString(totalText);
            doc.text(totalText, col4 + 45 - totalWidth, tableY + 2);

            tableY += rowHeight;
          }
        }

        const subtotalRowHeight = 26;
        doc
          .rect(
            tableLeft,
            tableY - 5,
            tableRight - tableLeft,
            subtotalRowHeight,
          )
          .stroke();
        doc.font("Helvetica-Bold").fontSize(9);
        doc.text("Subtotal", col1 + 10, tableY + 2);
        const subtotalText = `Nu ${orderData.subtotal.toFixed(2)}`;
        const subtotalWidth = doc.widthOfString(subtotalText);
        doc.text(subtotalText, col4 + 45 - subtotalWidth, tableY + 2);
        tableY += subtotalRowHeight;

        const deliveryFeeRowHeight = 26;
        doc
          .rect(
            tableLeft,
            tableY - 5,
            tableRight - tableLeft,
            deliveryFeeRowHeight,
          )
          .stroke();
        doc.text("Delivery Fee", col1 + 10, tableY + 2);
        const deliveryFeeText = `Nu ${orderData.delivery_fee.toFixed(2)}`;
        const deliveryFeeWidth = doc.widthOfString(deliveryFeeText);
        doc.text(deliveryFeeText, col4 + 45 - deliveryFeeWidth, tableY + 2);
        tableY += deliveryFeeRowHeight;

        const platformFeeRowHeight = 26;
        doc
          .rect(
            tableLeft,
            tableY - 5,
            tableRight - tableLeft,
            platformFeeRowHeight,
          )
          .stroke();
        doc.text("Platform Fee", col1 + 10, tableY + 2);
        const platformFeeText = `Nu ${orderData.platform_fee.toFixed(2)}`;
        const platformFeeWidth = doc.widthOfString(platformFeeText);
        doc.text(platformFeeText, col4 + 45 - platformFeeWidth, tableY + 2);
        tableY += platformFeeRowHeight;

        if (
          orderData.merchant_delivery_fee > 0 &&
          orderData.merchant_delivery_fee !== orderData.delivery_fee
        ) {
          const merchantFeeRowHeight = 26;
          doc
            .rect(
              tableLeft,
              tableY - 5,
              tableRight - tableLeft,
              merchantFeeRowHeight,
            )
            .stroke();
          doc.text("Merchant Delivery Fee", col1 + 10, tableY + 2);
          const merchantFeeText = `Nu ${orderData.merchant_delivery_fee.toFixed(2)}`;
          const merchantFeeWidth = doc.widthOfString(merchantFeeText);
          doc.text(merchantFeeText, col4 + 45 - merchantFeeWidth, tableY + 2);
          tableY += merchantFeeRowHeight;
        }

        if (orderData.discount_amount > 0) {
          const discountRowHeight = 26;
          doc
            .rect(
              tableLeft,
              tableY - 5,
              tableRight - tableLeft,
              discountRowHeight,
            )
            .stroke();
          doc.text("Discount", col1 + 10, tableY + 2);
          const discountText = `- Nu ${orderData.discount_amount.toFixed(2)}`;
          const discountWidth = doc.widthOfString(discountText);
          doc.text(discountText, col4 + 45 - discountWidth, tableY + 2);
          tableY += discountRowHeight;
        }

        const grandTotalRowHeight = 38;
        doc
          .rect(
            tableLeft,
            tableY - 5,
            tableRight - tableLeft,
            grandTotalRowHeight,
          )
          .fillAndStroke("#4CAF50", "#4CAF50");
        doc.fillColor("white");
        doc.font("Helvetica-Bold").fontSize(11);
        doc.text("GRAND TOTAL", col1 + 10, tableY + 10);
        const grandTotalText = `Nu ${orderData.grand_total.toFixed(2)}`;
        const grandTotalWidth = doc.widthOfString(grandTotalText);
        doc.text(grandTotalText, col4 + 45 - grandTotalWidth, tableY + 10);
        doc.fillColor("black");
        tableY += grandTotalRowHeight;

        doc
          .moveTo(tableLeft, tableY - 5)
          .lineTo(tableRight, tableY - 5)
          .stroke();

        currentY = tableY + 15;

        // ============ SEAL SECTION ============
        // Add seal below the table on the right side
        const sealWidth = 60;
        const sealHeight = 60;
        const sealX = 490; // Right side of page
        const sealY = currentY + 10;

        // Check if seal file exists
        if (fs.existsSync(this.sealPath)) {
          try {
            doc.image(this.sealPath, sealX, sealY, {
              width: sealWidth,
              height: sealHeight,
            });
            console.log("✅ Seal added to PDF");
          } catch (e) {
            console.error("Seal placement error:", e);
          }
        } else {
          console.log("⚠️ Seal not found at:", this.sealPath);
          // Optional: Add text as fallback
          doc
            .fontSize(7)
            .font("Helvetica")
            .fillColor("#666")
            .text("Authorized Signature", sealX + 5, sealY + 25, {
              align: "center",
              width: 50,
            });
          doc.fillColor("black");
        }

        // ============ FOOTER ============
        const pageHeight = doc.page.height;
        const bottomMargin = 50;
        const footerY = pageHeight - bottomMargin - 25;

        doc
          .fontSize(8)
          .font("Helvetica")
          .fillColor("#666")
          .text("Thank you for your order!", 50, footerY, { align: "center" })
          .text("For support contact: support@tabdhey.bt", 50, footerY + 12, {
            align: "center",
          });

        doc.end();
      } catch (error) {
        console.error("PDF Generation Error:", error);
        reject(error);
      }
    });
  }
}

module.exports = new PDFReceiptService();
