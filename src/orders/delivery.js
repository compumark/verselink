const expandDecimal = (value) => {
  const text = String(value);
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(text);
  if (!match) return null;
  const fraction = match[2] || "";
  const exponent = Number(match[3] || 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1000) return null;
  const digits = `${match[1]}${fraction}`;
  const point = match[1].length + exponent;
  if (point <= 0) return `0.${"0".repeat(-point)}${digits}`;
  if (point >= digits.length) return `${digits}${"0".repeat(point - digits.length)}`;
  return `${digits.slice(0, point)}.${digits.slice(point)}`;
};

// Browser forms submit decimal text. Validate it with the existing JavaScript
// Number acceptance boundary, then preserve decimal digits for PostgreSQL
// instead of round-tripping valid input through binary floating point.
export const canonicalizeBrowserOrderDeliveryQuantity = (value) => {
  const source = String(value ?? "").trim();
  const number = Number(source);
  if (!Number.isFinite(number) || number <= 0) return null;
  const match = /^\+?(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(source);
  if (!match) return String(number);
  const integer = match[1] || "0";
  const fraction = match[1] ? (match[2] || "") : (match[3] || "");
  const exponent = match[4] || "0";
  const expanded = expandDecimal(`${integer}${fraction ? `.${fraction}` : ""}e${exponent}`);
  if (!expanded) return null;
  const [whole, decimal = ""] = expanded.split(".");
  const normalizedWhole = whole.replace(/^0+(?=\d)/, "");
  const normalizedDecimal = decimal.replace(/0+$/, "");
  return normalizedDecimal ? `${normalizedWhole}.${normalizedDecimal}` : normalizedWhole;
};

export class OrderDeliveryError extends Error {
  constructor(reason) {
    super(reason);
    this.name = "OrderDeliveryError";
    this.reason = reason;
  }
}

// The caller owns the transaction. Locking the parent order before reading its
// ledger serializes browser and adapter reports on the same PostgreSQL row.
export const recordOrderDelivery = async (client, {
  orderId, deliveredBy, quantity, quality = null, groupId = null, visibleOnly = false, item = null, items = null
}) => {
  const amount = expandDecimal(quantity);
  if (!amount || !/^\d+(?:\.\d+)?$/.test(amount) || !/[1-9]/.test(amount)) {
    throw new OrderDeliveryError("invalid_quantity");
  }
  const order = await client.query(`
    SELECT id,group_id,created_by,order_number,material_name,required_quantity::text AS required_quantity,
      quantity_unit,delivered_quantity::text AS legacy_delivered_quantity,status,hidden_at,
      to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at
    FROM material_orders
    WHERE id=$1 AND ($2::uuid IS NULL OR group_id=$2) AND (NOT $3::boolean OR hidden_at IS NULL)
    FOR UPDATE`, [orderId, groupId, visibleOnly]);
  if (!order.rowCount) throw new OrderDeliveryError("not_found");
  const current = order.rows[0];
  const requestedItems = items || (item === null ? [] : [item]);
  if (requestedItems.some((name) => name !== current.material_name)) throw new OrderDeliveryError("item_not_in_order");
  if (["completed", "cancelled"].includes(current.status)) throw new OrderDeliveryError("closed");

  const ledger = await client.query(`
    SELECT COUNT(*)::int AS count,COALESCE(SUM(delivered_quantity),0)::text AS total
    FROM material_order_deliveries WHERE order_id=$1`, [orderId]);
  const ledgerCount = ledger.rows[0].count;
  if (ledgerCount === 0 && current.legacy_delivered_quantity != null) {
    const legacyNonzero = await client.query("SELECT $1::numeric <> 0 AS nonzero", [current.legacy_delivered_quantity]);
    if (legacyNonzero.rows[0].nonzero) throw new OrderDeliveryError("legacy_progress");
  }
  const deliveredBefore = ledger.rows[0].total;
  const remaining = await client.query(
    "SELECT $1::numeric <= GREATEST($2::numeric-$3::numeric,0::numeric) AS allowed",
    [amount, current.required_quantity, deliveredBefore]
  );
  if (!remaining.rows[0].allowed) throw new OrderDeliveryError("exceeds_remaining");

  const inserted = await client.query(`
    INSERT INTO material_order_deliveries(order_id,delivered_by,delivered_quantity,delivered_quality)
    VALUES($1,$2,$3,$4) RETURNING id`, [orderId, deliveredBy, amount, quality]);
  const total = await client.query(
    "SELECT COALESCE(SUM(delivered_quantity),0)::text AS total FROM material_order_deliveries WHERE order_id=$1",
    [orderId]
  );
  const updated = await client.query(`
    UPDATE material_orders SET
      status=CASE WHEN $1::numeric >= required_quantity THEN 'completed' ELSE 'reported' END,
      delivered_quantity=$1::numeric,
      delivered_quality=$2,
      completed_at=CASE WHEN $1::numeric >= required_quantity THEN now() ELSE NULL END
    WHERE id=$3
    RETURNING id,order_number,material_name,required_quantity::text AS required_quantity,quantity_unit,status,
      delivered_quantity::text AS delivered_quantity,
      to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at`,
  [total.rows[0].total, quality, orderId]);

  if (updated.rows[0].status === "completed") {
    await client.query(`
      INSERT INTO app_notifications(app_user_id,kind,title,message,order_id)
      SELECT $1,'order_completed',$2,$3,$4
      WHERE NOT EXISTS (SELECT 1 FROM app_notifications WHERE order_id=$4 AND kind='order_completed')`,
    [current.created_by, `ORDER COMPLETED ${current.order_number}`,
      `${current.material_name} · ${total.rows[0].total} ${current.quantity_unit}`, orderId]);
  }

  return { deliveryId: inserted.rows[0].id, order: updated.rows[0] };
};
