using System;
using System.Collections.Generic;
using VerseLink.Companion;
using Xunit;
namespace VerseLink.Companion.Tests;
public class SpatialTests {
 [Fact] public void RoiRoundTrip(){var r=new RegionOfInterest(RegionType.WorkOrder,.2,.1,.5,.4);var p=r.ToPixels(1000,500);var x=RegionOfInterest.FromPixels(RegionType.WorkOrder,p,1000,500);Assert.Equal(r.RelativeX,x.RelativeX,2);Assert.Equal(r.RelativeHeight,x.RelativeHeight,2);}
 [Fact] public void SpatialRowsAndCorrection(){var w=new List<OcrWord>{new("COMPLETED",0,0,60,10),new("MATERIAL",0,20,80,10),new("QUALITY",100,20,50,10),new("YIELD",200,20,40,10),new("STILERON",0,50,80,10),new("330",100,51,30,10),new("2SS",200,49,30,10),new("STILERON",0,80,80,10),new("681",100,81,30,10),new("34",200,79,30,10)};var r=RefinerySpatialParser.Parse(new("",[],w,300,200,TimeSpan.Zero),"CHECKMATE");Assert.Equal("Checkmate Station",r.Location);Assert.Equal(2,r.Rows.Count);Assert.Equal(255,r.Rows[0].YieldCscu);Assert.Contains("OCR_NUMERIC_CORRECTION",r.Rows[0].Warnings);}
 [Theory] [InlineData("CHECKMATE","pyro-checkmate","Checkmate Station","Pyro",LocationMatchType.UNIQUE_ALIAS)] [InlineData("CHECKMATE STATION","pyro-checkmate","Checkmate Station","Pyro",LocationMatchType.EXACT)] [InlineData("ARC-L1","stanton-arc-l1","ARC-L1 Wide Forest Station","Stanton",LocationMatchType.UNIQUE_ALIAS)] [InlineData("WIDE FOREST","stanton-arc-l1","ARC-L1 Wide Forest Station","Stanton",LocationMatchType.UNIQUE_ALIAS)] [InlineData("LEVSKI","nyx-levski","Levski","Nyx",LocationMatchType.EXACT)] public void CatalogMatches(string raw,string id,string name,string system,LocationMatchType type){var m=RefineryLocationCatalog.Match(raw);Assert.Equal(id,m.LocationId);Assert.Equal(name,m.Name);Assert.Equal(system,m.System);Assert.Equal(type,m.MatchType);}
 [Fact] public void GatewayWithoutHintIsAmbiguous(){var m=RefineryLocationCatalog.Match("NYX GATEWAY");Assert.Equal(LocationMatchType.AMBIGUOUS,m.MatchType);Assert.Null(m.LocationId);}
 [Fact] public void GatewayWithSystemHintIsResolved(){var m=RefineryLocationCatalog.Match("NYX GATEWAY","Pyro");Assert.Equal("pyro-nyx-gateway",m.LocationId);Assert.Equal(LocationMatchType.UNIQUE_ALIAS,m.MatchType);}
}
