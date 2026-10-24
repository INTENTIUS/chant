-- A small excerpt of the WideWorldImporters sample database, used as a test
-- fixture for the SQL Server import source (INTENTIUS/chant#4398).
--
-- Source:  https://github.com/microsoft/sql-server-samples
-- Commit:  348bbbc25079785f93ea74be3dd0d6369a59358f
-- Paths:   samples/databases/wide-world-importers/wwi-ssdt/wwi-ssdt/ (listed
--          above each block). Batches are copied as published; some index and
--          sp_addextendedproperty batches are left out to keep the file small.
-- Licence: MIT. Copyright (c) Microsoft Corporation. The licence text is
--          the root license.txt of that repository and is kept beside this
--          file as LICENSE-sql-server-samples.txt.
--
-- Permission is hereby granted, free of charge, to any person obtaining a copy
-- of this software and associated documentation files (the "Software"), to deal
-- in the Software without restriction, including without limitation the rights
-- to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
-- copies of the Software, and to permit persons to whom the Software is
-- furnished to do so, subject to the following conditions:
--
-- The above copyright notice and this permission notice shall be included in
-- all copies or substantial portions of the Software.
--
-- THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.

-- Source: samples/databases/wide-world-importers/wwi-ssdt/wwi-ssdt/Warehouse/Tables/StockItemTransactions.sql
CREATE TABLE [Warehouse].[StockItemTransactions] (
    [StockItemTransactionID]  INT             CONSTRAINT [DF_Warehouse_StockItemTransactions_StockItemTransactionID] DEFAULT (NEXT VALUE FOR [Sequences].[TransactionID]) NOT NULL,
    [StockItemID]             INT             NOT NULL,
    [TransactionTypeID]       INT             NOT NULL,
    [CustomerID]              INT             NULL,
    [InvoiceID]               INT             NULL,
    [SupplierID]              INT             NULL,
    [PurchaseOrderID]         INT             NULL,
    [TransactionOccurredWhen] DATETIME2 (7)   NOT NULL,
    [Quantity]                DECIMAL (18, 3) NOT NULL,
    [LastEditedBy]            INT             NOT NULL,
    [LastEditedWhen]          DATETIME2 (7)   CONSTRAINT [DF_Warehouse_StockItemTransactions_LastEditedWhen] DEFAULT (sysdatetime()) NOT NULL,
    CONSTRAINT [PK_Warehouse_StockItemTransactions] PRIMARY KEY NONCLUSTERED ([StockItemTransactionID] ASC),
    CONSTRAINT [FK_Warehouse_StockItemTransactions_Application_People] FOREIGN KEY ([LastEditedBy]) REFERENCES [Application].[People] ([PersonID]),
    CONSTRAINT [FK_Warehouse_StockItemTransactions_CustomerID_Sales_Customers] FOREIGN KEY ([CustomerID]) REFERENCES [Sales].[Customers] ([CustomerID]),
    CONSTRAINT [FK_Warehouse_StockItemTransactions_InvoiceID_Sales_Invoices] FOREIGN KEY ([InvoiceID]) REFERENCES [Sales].[Invoices] ([InvoiceID]),
    CONSTRAINT [FK_Warehouse_StockItemTransactions_PurchaseOrderID_Purchasing_PurchaseOrders] FOREIGN KEY ([PurchaseOrderID]) REFERENCES [Purchasing].[PurchaseOrders] ([PurchaseOrderID]),
    CONSTRAINT [FK_Warehouse_StockItemTransactions_StockItemID_Warehouse_StockItems] FOREIGN KEY ([StockItemID]) REFERENCES [Warehouse].[StockItems] ([StockItemID]),
    CONSTRAINT [FK_Warehouse_StockItemTransactions_SupplierID_Purchasing_Suppliers] FOREIGN KEY ([SupplierID]) REFERENCES [Purchasing].[Suppliers] ([SupplierID]),
    CONSTRAINT [FK_Warehouse_StockItemTransactions_TransactionTypeID_Application_TransactionTypes] FOREIGN KEY ([TransactionTypeID]) REFERENCES [Application].[TransactionTypes] ([TransactionTypeID])
);
GO
CREATE NONCLUSTERED INDEX [FK_Warehouse_StockItemTransactions_StockItemID]
    ON [Warehouse].[StockItemTransactions]([StockItemID] ASC);
GO
CREATE CLUSTERED COLUMNSTORE INDEX [CCX_Warehouse_StockItemTransactions]
    ON [Warehouse].[StockItemTransactions];
GO
EXECUTE sp_addextendedproperty @name = N'Description', @value = N'Transactions covering all movements of all stock items', @level0type = N'SCHEMA', @level0name = N'Warehouse', @level1type = N'TABLE', @level1name = N'StockItemTransactions';
GO
EXECUTE sp_addextendedproperty @name = N'Description', @value = 'StockItem for this transaction', @level0type = N'SCHEMA', @level0name = N'Warehouse', @level1type = N'TABLE', @level1name = N'StockItemTransactions', @level2type = N'COLUMN', @level2name = N'StockItemID';
GO

-- Source: samples/databases/wide-world-importers/wwi-ssdt/wwi-ssdt/Sales/Tables/CustomerTransactions.sql
CREATE TABLE [Sales].[CustomerTransactions] (
    [CustomerTransactionID] INT             CONSTRAINT [DF_Sales_CustomerTransactions_CustomerTransactionID] DEFAULT (NEXT VALUE FOR [Sequences].[TransactionID]) NOT NULL,
    [CustomerID]            INT             NOT NULL,
    [TransactionTypeID]     INT             NOT NULL,
    [InvoiceID]             INT             NULL,
    [PaymentMethodID]       INT             NULL,
    [TransactionDate]       DATE            NOT NULL,
    [AmountExcludingTax]    DECIMAL (18, 2) NOT NULL,
    [TaxAmount]             DECIMAL (18, 2) NOT NULL,
    [TransactionAmount]     DECIMAL (18, 2) NOT NULL,
    [OutstandingBalance]    DECIMAL (18, 2) NOT NULL,
    [FinalizationDate]      DATE            NULL,
    [IsFinalized]           AS              (case when [FinalizationDate] IS NULL then CONVERT([bit],(0)) else CONVERT([bit],(1)) end) PERSISTED,
    [LastEditedBy]          INT             NOT NULL,
    [LastEditedWhen]        DATETIME2 (7)   CONSTRAINT [DF_Sales_CustomerTransactions_LastEditedWhen] DEFAULT (sysdatetime()) NOT NULL,
    CONSTRAINT [PK_Sales_CustomerTransactions] PRIMARY KEY NONCLUSTERED ([CustomerTransactionID] ASC),
    CONSTRAINT [FK_Sales_CustomerTransactions_Application_People] FOREIGN KEY ([LastEditedBy]) REFERENCES [Application].[People] ([PersonID]),
    CONSTRAINT [FK_Sales_CustomerTransactions_CustomerID_Sales_Customers] FOREIGN KEY ([CustomerID]) REFERENCES [Sales].[Customers] ([CustomerID]),
    CONSTRAINT [FK_Sales_CustomerTransactions_InvoiceID_Sales_Invoices] FOREIGN KEY ([InvoiceID]) REFERENCES [Sales].[Invoices] ([InvoiceID]),
    CONSTRAINT [FK_Sales_CustomerTransactions_PaymentMethodID_Application_PaymentMethods] FOREIGN KEY ([PaymentMethodID]) REFERENCES [Application].[PaymentMethods] ([PaymentMethodID]),
    CONSTRAINT [FK_Sales_CustomerTransactions_TransactionTypeID_Application_TransactionTypes] FOREIGN KEY ([TransactionTypeID]) REFERENCES [Application].[TransactionTypes] ([TransactionTypeID])
);
GO
CREATE CLUSTERED INDEX [CX_Sales_CustomerTransactions]
    ON [Sales].[CustomerTransactions]([TransactionDate] ASC)
    ON [PS_TransactionDate] ([TransactionDate]);
GO
CREATE NONCLUSTERED INDEX [FK_Sales_CustomerTransactions_CustomerID]
    ON [Sales].[CustomerTransactions]([CustomerID] ASC)
    ON [PS_TransactionDate] ([TransactionDate]);
GO
CREATE NONCLUSTERED INDEX [IX_Sales_CustomerTransactions_IsFinalized]
    ON [Sales].[CustomerTransactions]([IsFinalized] ASC)
    ON [PS_TransactionDate] ([TransactionDate]);
GO
EXECUTE sp_addextendedproperty @name = N'Description', @value = 'Is this transaction finalized (invoices, credits and payments have been matched)', @level0type = N'SCHEMA', @level0name = N'Sales', @level1type = N'TABLE', @level1name = N'CustomerTransactions', @level2type = N'COLUMN', @level2name = N'IsFinalized';
GO

-- Source: samples/databases/wide-world-importers/wwi-ssdt/wwi-ssdt/Sales/Tables/Orders.sql
CREATE TABLE [Sales].[Orders] (
    [OrderID]                     INT            CONSTRAINT [DF_Sales_Orders_OrderID] DEFAULT (NEXT VALUE FOR [Sequences].[OrderID]) NOT NULL,
    [CustomerID]                  INT            NOT NULL,
    [SalespersonPersonID]         INT            NOT NULL,
    [PickedByPersonID]            INT            NULL,
    [ContactPersonID]             INT            NOT NULL,
    [BackorderOrderID]            INT            NULL,
    [OrderDate]                   DATE           NOT NULL,
    [ExpectedDeliveryDate]        DATE           NOT NULL,
    [CustomerPurchaseOrderNumber] NVARCHAR (20)  NULL,
    [IsUndersupplyBackordered]    BIT            NOT NULL,
    [Comments]                    NVARCHAR (MAX) NULL,
    [DeliveryInstructions]        NVARCHAR (MAX) NULL,
    [InternalComments]            NVARCHAR (MAX) NULL,
    [PickingCompletedWhen]        DATETIME2 (7)  NULL,
    [LastEditedBy]                INT            NOT NULL,
    [LastEditedWhen]              DATETIME2 (7)  CONSTRAINT [DF_Sales_Orders_LastEditedWhen] DEFAULT (sysdatetime()) NOT NULL,
    CONSTRAINT [PK_Sales_Orders] PRIMARY KEY CLUSTERED ([OrderID] ASC),
    CONSTRAINT [FK_Sales_Orders_Application_People] FOREIGN KEY ([LastEditedBy]) REFERENCES [Application].[People] ([PersonID]),
    CONSTRAINT [FK_Sales_Orders_BackorderOrderID_Sales_Orders] FOREIGN KEY ([BackorderOrderID]) REFERENCES [Sales].[Orders] ([OrderID]),
    CONSTRAINT [FK_Sales_Orders_ContactPersonID_Application_People] FOREIGN KEY ([ContactPersonID]) REFERENCES [Application].[People] ([PersonID]),
    CONSTRAINT [FK_Sales_Orders_CustomerID_Sales_Customers] FOREIGN KEY ([CustomerID]) REFERENCES [Sales].[Customers] ([CustomerID]),
    CONSTRAINT [FK_Sales_Orders_PickedByPersonID_Application_People] FOREIGN KEY ([PickedByPersonID]) REFERENCES [Application].[People] ([PersonID]),
    CONSTRAINT [FK_Sales_Orders_SalespersonPersonID_Application_People] FOREIGN KEY ([SalespersonPersonID]) REFERENCES [Application].[People] ([PersonID])
);
GO
CREATE NONCLUSTERED INDEX [FK_Sales_Orders_CustomerID]
    ON [Sales].[Orders]([CustomerID] ASC);
GO
EXECUTE sp_addextendedproperty @name = N'Description', @value = N'Detail of customer orders', @level0type = N'SCHEMA', @level0name = N'Sales', @level1type = N'TABLE', @level1name = N'Orders';
GO
EXECUTE sp_addextendedproperty @name = N'Description', @value = 'Date that this order was raised', @level0type = N'SCHEMA', @level0name = N'Sales', @level1type = N'TABLE', @level1name = N'Orders', @level2type = N'COLUMN', @level2name = N'OrderDate';
GO

-- Source: samples/databases/wide-world-importers/wwi-ssdt/wwi-ssdt/Warehouse/Tables/Colors.sql
CREATE TABLE [Warehouse].[Colors] (
    [ColorID]      INT                                         CONSTRAINT [DF_Warehouse_Colors_ColorID] DEFAULT (NEXT VALUE FOR [Sequences].[ColorID]) NOT NULL,
    [ColorName]    NVARCHAR (20)                               NOT NULL,
    [LastEditedBy] INT                                         NOT NULL,
    [ValidFrom]    DATETIME2 (7) GENERATED ALWAYS AS ROW START NOT NULL,
    [ValidTo]      DATETIME2 (7) GENERATED ALWAYS AS ROW END   NOT NULL,
    CONSTRAINT [PK_Warehouse_Colors] PRIMARY KEY CLUSTERED ([ColorID] ASC),
    CONSTRAINT [FK_Warehouse_Colors_Application_People] FOREIGN KEY ([LastEditedBy]) REFERENCES [Application].[People] ([PersonID]),
    CONSTRAINT [UQ_Warehouse_Colors_ColorName] UNIQUE NONCLUSTERED ([ColorName] ASC),
    PERIOD FOR SYSTEM_TIME ([ValidFrom], [ValidTo])
)
WITH (SYSTEM_VERSIONING = ON (HISTORY_TABLE=[Warehouse].[Colors_Archive], DATA_CONSISTENCY_CHECK=ON));
GO
EXECUTE sp_addextendedproperty @name = N'Description', @value = 'Full name of a color that can be used to describe stock items', @level0type = N'SCHEMA', @level0name = N'Warehouse', @level1type = N'TABLE', @level1name = N'Colors', @level2type = N'COLUMN', @level2name = N'ColorName';
GO

-- Source: samples/databases/wide-world-importers/wwi-ssdt/wwi-ssdt/Warehouse/Tables/ColdRoomTemperatures.sql
CREATE TABLE [Warehouse].[ColdRoomTemperatures] (
    [ColdRoomTemperatureID] BIGINT                                      IDENTITY (1, 1) NOT NULL,
    [ColdRoomSensorNumber]  INT                                         NOT NULL,
    [RecordedWhen]          DATETIME2 (7)                               NOT NULL,
    [Temperature]           DECIMAL (10, 2)                             NOT NULL,
    [ValidFrom]             DATETIME2 (7) GENERATED ALWAYS AS ROW START NOT NULL,
    [ValidTo]               DATETIME2 (7) GENERATED ALWAYS AS ROW END   NOT NULL,
    CONSTRAINT [PK_Warehouse_ColdRoomTemperatures] PRIMARY KEY NONCLUSTERED ([ColdRoomTemperatureID] ASC),
    INDEX [IX_Warehouse_ColdRoomTemperatures_ColdRoomSensorNumber] NONCLUSTERED ([ColdRoomSensorNumber]),
    PERIOD FOR SYSTEM_TIME ([ValidFrom], [ValidTo])
)
WITH (MEMORY_OPTIMIZED = ON, SYSTEM_VERSIONING = ON (HISTORY_TABLE=[Warehouse].[ColdRoomTemperatures_Archive], DATA_CONSISTENCY_CHECK=ON));
GO

-- Source: samples/databases/wide-world-importers/wwi-ssdt/wwi-ssdt/WebApi/Views/Colors.sql
CREATE VIEW [WebApi].[Colors]
AS
SELECT ColorID, ColorName
FROM Warehouse.Colors
GO
