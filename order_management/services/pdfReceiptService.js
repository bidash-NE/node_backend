// services/pdfReceiptService.js
const PDFDocument = require("pdfkit");
const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");

class PDFReceiptService {
  constructor() {
    this.sealPath = path.join(__dirname, "../assets/seals/official-seal.png");
  }

  safeNumber(value, defaultValue = 0) {
    const num = parseFloat(value);
    return isNaN(num) ? defaultValue : num;
  }

  // Calculate total height needed for all items
  calculateItemsHeight(items, doc) {
    let totalHeight = 0;
    for (const item of items) {
      const itemName = item.menu_name || "Item";
      const itemHeight = doc.heightOfString(itemName, { width: 290 });
      totalHeight += Math.max(itemHeight + 18, 30);
    }
    return totalHeight;
  }

  // Calculate totals height
  calculateTotalsHeight(orderData) {
    const platformFee = this.safeNumber(orderData.platform_fee);
    const discountAmount = this.safeNumber(orderData.discount_amount);
    const customerDeliveryFee = this.safeNumber(orderData.delivery_fee);
    const merchantDeliveryFee = this.safeNumber(
      orderData.merchant_delivery_fee,
    );

    let height = 64; // Subtotal (26) + Grand Total (38)
    if (platformFee > 0) height += 26;
    if (discountAmount > 0) height += 26;
    if (customerDeliveryFee > 0) height += 26;
    if (merchantDeliveryFee > 0 && customerDeliveryFee === 0) height += 26;
    return height;
  }

  async downloadImage(url) {
    return new Promise((resolve) => {
      if (!url) return resolve(null);
      if (!url.startsWith("http")) return resolve(null);

      const client = url.startsWith("https") ? https : http;
      const request = client.get(url, (response) => {
        if (response.statusCode === 301 || response.statusCode === 302) {
          if (response.headers.location) {
            this.downloadImage(response.headers.location).then(resolve);
            return;
          }
        }
        if (response.statusCode !== 200) return resolve(null);

        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => resolve(Buffer.concat(chunks)));
      });
      request.on("error", () => resolve(null));
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

        // ============ LETTERHEAD ============
        let logoBuffer = null;
        let logoDownloaded = false;

        if (orderData.business_logo) {
          logoBuffer = await this.downloadImage(orderData.business_logo);
          if (logoBuffer) logoDownloaded = true;
        }

        doc
          .fontSize(16)
          .font("Helvetica-Bold")
          .text(orderData.business_name || "TabDhey", 50, currentY, {
            width: 350,
          });
        doc
          .fontSize(8)
          .font("Helvetica")
          .text(
            orderData.business_address || "Thimphu, Bhutan",
            50,
            currentY + 20,
            { width: 350 },
          );

        if (logoDownloaded && logoBuffer) {
          try {
            doc.image(logoBuffer, 480, currentY, { width: 60, height: 60 });
          } catch (e) {}
        }

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

        // ============ ORDER INFO ============
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

        // ============ CUSTOMER INFO ============
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

        const addressText = `Delivery Address: ${orderData.delivery_address}`;
        doc.text(addressText, 50, currentY + 55, { width: 460 });
        const addressHeight = doc.heightOfString(addressText, { width: 460 });
        currentY = currentY + 80 + Math.max(0, addressHeight - 20);
        currentY += 15;

        // ============ CALCULATE PAGE BREAKS ============
        const pageHeight = doc.page.height;
        const bottomReserve = 120; // Reserve space for footer
        const availableHeight = pageHeight - currentY - bottomReserve;

        const items = orderData.items || [];
        const totalsHeight = this.calculateTotalsHeight(orderData);
        const maxItemsHeight = availableHeight - totalsHeight;

        // Calculate how many items fit on first page
        let itemsOnFirstPage = 0;
        let usedHeight = 0;

        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          const itemName = item.menu_name || "Item";
          const itemHeight = doc.heightOfString(itemName, { width: 290 });
          const rowHeight = Math.max(itemHeight + 18, 30);

          if (usedHeight + rowHeight <= maxItemsHeight) {
            usedHeight += rowHeight;
            itemsOnFirstPage++;
          } else {
            break;
          }
        }

        // Ensure at least 1 item per page
        if (itemsOnFirstPage === 0 && items.length > 0) itemsOnFirstPage = 1;

        const itemsOnFirst = items.slice(0, itemsOnFirstPage);
        const itemsOnRest = items.slice(itemsOnFirstPage);

        // ============ TABLE HEADER ============
        const col1 = 50,
          col2 = 350,
          col3 = 415,
          col4 = 495;
        const tableLeft = 45,
          tableRight = 555;

        const drawTableHeader = (y) => {
          doc.rect(tableLeft, y - 5, tableRight - tableLeft, 28).stroke();
          doc
            .moveTo(col2, y - 5)
            .lineTo(col2, y + 23)
            .stroke();
          doc
            .moveTo(col3, y - 5)
            .lineTo(col3, y + 23)
            .stroke();
          doc
            .moveTo(col4, y - 5)
            .lineTo(col4, y + 23)
            .stroke();
          doc.font("Helvetica-Bold").fontSize(9);
          doc.text("Item", col1, y + 5);
          doc.text("Qty", col2 + 18, y + 5);
          doc.text("Price", col3 + 12, y + 5);
          doc.text("Total", col4, y + 5);
          doc
            .moveTo(tableLeft, y + 23)
            .lineTo(tableRight, y + 23)
            .stroke();
          return y + 28;
        };

        // ============ RENDER FIRST PAGE ITEMS ============
        let tableY = drawTableHeader(currentY);

        for (const item of itemsOnFirst) {
          const itemName = item.menu_name || "Item";
          const quantity = item.quantity || 0;
          const price = this.safeNumber(item.price_per_unit);
          const total = this.safeNumber(item.subtotal) || price * quantity;

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

        // ============ RENDER TOTALS ON FIRST PAGE ============
        await this.renderTotals(
          doc,
          orderData,
          tableLeft,
          tableRight,
          col1,
          col4,
          tableY,
        );

        // ============ RENDER REMAINING ITEMS ON NEW PAGES ============
        if (itemsOnRest.length > 0) {
          let remainingItems = [...itemsOnRest];

          while (remainingItems.length > 0) {
            doc.addPage();
            let newPageY = 40;

            doc
              .fontSize(12)
              .font("Helvetica-Bold")
              .text("ORDER RECEIPT (Continued)", 50, newPageY, {
                align: "center",
              });
            newPageY = doc.y + 20;

            // Calculate how many items fit on this page
            const pageAvailableHeight =
              doc.page.height - newPageY - bottomReserve - totalsHeight;
            let itemsOnThisPage = 0;
            let pageUsedHeight = 0;

            for (let i = 0; i < remainingItems.length; i++) {
              const item = remainingItems[i];
              const itemName = item.menu_name || "Item";
              const itemHeight = doc.heightOfString(itemName, { width: 290 });
              const rowHeight = Math.max(itemHeight + 18, 30);

              if (pageUsedHeight + rowHeight <= pageAvailableHeight) {
                pageUsedHeight += rowHeight;
                itemsOnThisPage++;
              } else {
                break;
              }
            }

            if (itemsOnThisPage === 0 && remainingItems.length > 0)
              itemsOnThisPage = 1;

            const itemsForPage = remainingItems.slice(0, itemsOnThisPage);
            remainingItems = remainingItems.slice(itemsOnThisPage);

            // Draw table header
            let pageTableY = drawTableHeader(newPageY);

            for (const item of itemsForPage) {
              const itemName = item.menu_name || "Item";
              const quantity = item.quantity || 0;
              const price = this.safeNumber(item.price_per_unit);
              const total = this.safeNumber(item.subtotal) || price * quantity;

              const itemHeight = doc.heightOfString(itemName, { width: 290 });
              const rowHeight = Math.max(itemHeight + 18, 30);

              doc
                .rect(
                  tableLeft,
                  pageTableY - 5,
                  tableRight - tableLeft,
                  rowHeight,
                )
                .stroke();
              doc
                .moveTo(col2, pageTableY - 5)
                .lineTo(col2, pageTableY + rowHeight - 5)
                .stroke();
              doc
                .moveTo(col3, pageTableY - 5)
                .lineTo(col3, pageTableY + rowHeight - 5)
                .stroke();
              doc
                .moveTo(col4, pageTableY - 5)
                .lineTo(col4, pageTableY + rowHeight - 5)
                .stroke();

              doc.font("Helvetica").fontSize(8);
              doc.text(itemName, col1, pageTableY + 2, {
                width: 290,
                lineGap: 2,
              });
              doc.text(quantity.toString(), col2 + 20, pageTableY + 2);

              const priceText = `Nu ${price.toFixed(2)}`;
              const priceWidth = doc.widthOfString(priceText);
              doc.text(priceText, col3 + 65 - priceWidth, pageTableY + 2);

              const totalText = `Nu ${total.toFixed(2)}`;
              const totalWidth = doc.widthOfString(totalText);
              doc.text(totalText, col4 + 45 - totalWidth, pageTableY + 2);

              pageTableY += rowHeight;
            }

            // Only show totals on the last page
            if (remainingItems.length === 0) {
              await this.renderTotals(
                doc,
                orderData,
                tableLeft,
                tableRight,
                col1,
                col4,
                pageTableY,
              );
            }
          }
        }

        // ============ FOOTER ============
        const footerY = doc.page.height - 50;
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

  async renderTotals(
    doc,
    orderData,
    tableLeft,
    tableRight,
    col1,
    col4,
    startY,
  ) {
    const subtotal = this.safeNumber(orderData.subtotal);
    const platformFee = this.safeNumber(orderData.platform_fee);
    const discountAmount = this.safeNumber(orderData.discount_amount);
    const customerDeliveryFee = this.safeNumber(orderData.delivery_fee);
    const merchantDeliveryFee = this.safeNumber(
      orderData.merchant_delivery_fee,
    );
    const grandTotal = this.safeNumber(orderData.grand_total) || subtotal;

    let totalsY = startY;

    const subtotalRowHeight = 26;
    doc
      .rect(tableLeft, totalsY - 5, tableRight - tableLeft, subtotalRowHeight)
      .stroke();
    doc.font("Helvetica-Bold").fontSize(9);
    doc.text("Subtotal", col1 + 10, totalsY + 2);
    const subtotalText = `Nu ${subtotal.toFixed(2)}`;
    const subtotalWidth = doc.widthOfString(subtotalText);
    doc.text(subtotalText, col4 + 45 - subtotalWidth, totalsY + 2);
    totalsY += subtotalRowHeight;

    if (platformFee > 0) {
      const rowHeight = 26;
      doc
        .rect(tableLeft, totalsY - 5, tableRight - tableLeft, rowHeight)
        .stroke();
      doc.text("Platform Fee", col1 + 10, totalsY + 2);
      const text = `Nu ${platformFee.toFixed(2)}`;
      const textWidth = doc.widthOfString(text);
      doc.text(text, col4 + 45 - textWidth, totalsY + 2);
      totalsY += rowHeight;
    }

    if (discountAmount > 0) {
      const rowHeight = 26;
      doc
        .rect(tableLeft, totalsY - 5, tableRight - tableLeft, rowHeight)
        .stroke();
      doc.text("Discount", col1 + 10, totalsY + 2);
      const text = `- Nu ${discountAmount.toFixed(2)}`;
      const textWidth = doc.widthOfString(text);
      doc.text(text, col4 + 45 - textWidth, totalsY + 2);
      totalsY += rowHeight;
    }

    if (customerDeliveryFee > 0) {
      const rowHeight = 26;
      doc
        .rect(tableLeft, totalsY - 5, tableRight - tableLeft, rowHeight)
        .stroke();
      doc.text("Delivery Fee", col1 + 10, totalsY + 2);
      const text = `Nu ${customerDeliveryFee.toFixed(2)}`;
      const textWidth = doc.widthOfString(text);
      doc.text(text, col4 + 45 - textWidth, totalsY + 2);
      totalsY += rowHeight;
    }

    if (merchantDeliveryFee > 0 && customerDeliveryFee === 0) {
      const rowHeight = 26;
      doc
        .rect(tableLeft, totalsY - 5, tableRight - tableLeft, rowHeight)
        .stroke();
      doc.text("Delivery Fee (Paid by Merchant)", col1 + 10, totalsY + 2);
      const text = `Nu ${merchantDeliveryFee.toFixed(2)}`;
      const textWidth = doc.widthOfString(text);
      doc.text(text, col4 + 45 - textWidth, totalsY + 2);
      totalsY += rowHeight;
    }

    const grandTotalRowHeight = 38;
    doc
      .rect(tableLeft, totalsY - 5, tableRight - tableLeft, grandTotalRowHeight)
      .fillAndStroke("#4CAF50", "#4CAF50");
    doc.fillColor("white");
    doc.font("Helvetica-Bold").fontSize(11);
    doc.text("GRAND TOTAL", col1 + 10, totalsY + 10);
    const grandTotalText = `Nu ${grandTotal.toFixed(2)}`;
    const grandTotalWidth = doc.widthOfString(grandTotalText);
    doc.text(grandTotalText, col4 + 45 - grandTotalWidth, totalsY + 10);
    doc.fillColor("black");
    totalsY += grandTotalRowHeight;

    doc
      .moveTo(tableLeft, totalsY - 5)
      .lineTo(tableRight, totalsY - 5)
      .stroke();

    return totalsY;
  }
}

module.exports = new PDFReceiptService();
