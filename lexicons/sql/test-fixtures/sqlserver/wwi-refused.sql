-- One function of the WideWorldImporters sample database, a test fixture for the refusal in the SQL Server import source (INTENTIUS/chant#4398).
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

-- Source: samples/databases/wide-world-importers/wwi-ssdt/wwi-ssdt/Application/Functions/DetermineCustomerAccess.sql
CREATE FUNCTION [Application].DetermineCustomerAccess(@CityID int)
RETURNS TABLE
WITH SCHEMABINDING
AS
RETURN (SELECT 1 AS AccessResult
        WHERE IS_ROLEMEMBER(N'db_owner') <> 0
        OR IS_ROLEMEMBER((SELECT sp.SalesTerritory
                          FROM [Application].Cities AS c
                          INNER JOIN [Application].StateProvinces AS sp
                          ON c.StateProvinceID = sp.StateProvinceID
                          WHERE c.CityID = @CityID) + N' Sales') <> 0
	    OR ((ORIGINAL_LOGIN() = N'Website' OR ORIGINAL_LOGIN() = N'WebApi')
		    AND EXISTS (SELECT 1
		                FROM [Application].Cities AS c
				        INNER JOIN [Application].StateProvinces AS sp
				        ON c.StateProvinceID = sp.StateProvinceID
				        WHERE c.CityID = @CityID
				        AND sp.SalesTerritory = SESSION_CONTEXT(N'SalesTerritory'))));
